-- =========================================================
-- Waduge Inn: PostgreSQL Schema Definition (DDL Only)
-- STRICT RULE: ZERO DUMMY / SEED / MOCK DATA
-- =========================================================

-- Enable pgcrypto for UUID generation if needed
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table: rooms
CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_number VARCHAR(50) NOT NULL UNIQUE,
    room_type VARCHAR(100) NOT NULL,
    price_per_night NUMERIC(10, 2) NOT NULL CHECK (price_per_night >= 0),
    max_occupancy INT NOT NULL CHECK (max_occupancy > 0),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Table: bookings
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    guest_name VARCHAR(150) NOT NULL,
    guest_email VARCHAR(255) NOT NULL,
    guest_phone VARCHAR(50) NOT NULL,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    total_price NUMERIC(10, 2) NOT NULL CHECK (total_price >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_booking_dates CHECK (check_out > check_in)
);

-- 3. Indices for performance and date collision queries
-- Legacy bookings retain NULL identity fields; new requests require these in the API.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_type VARCHAR(10) CHECK (guest_type IN ('local', 'foreign'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_identity VARCHAR(30);

CREATE INDEX IF NOT EXISTS idx_bookings_room_dates 
ON bookings (room_id, check_in, check_out) 
WHERE status != 'cancelled';

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS image_url TEXT;
-- Real rooms may be listed before their rate/capacity is supplied.
-- Booking APIs reject incomplete rooms and floors.
ALTER TABLE rooms ALTER COLUMN price_per_night DROP NOT NULL;
ALTER TABLE rooms ALTER COLUMN max_occupancy DROP NOT NULL;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor_number INT NOT NULL DEFAULT 1 CHECK (floor_number IN (1, 2));
-- A stable slot lets the exclusion constraint compare a room against a whole floor.
CREATE SEQUENCE IF NOT EXISTS room_inventory_slots;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS inventory_slot BIGINT;
ALTER TABLE rooms ALTER COLUMN inventory_slot SET DEFAULT nextval('room_inventory_slots');
UPDATE rooms SET inventory_slot = nextval('room_inventory_slots') WHERE inventory_slot IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_inventory_slot ON rooms(inventory_slot);
ALTER TABLE rooms ALTER COLUMN inventory_slot SET NOT NULL;
ALTER TABLE bookings ALTER COLUMN room_id DROP NOT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS floor_number INT CHECK (floor_number IN (1, 2));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS inventory_span INT8RANGE;
UPDATE bookings b SET floor_number = r.floor_number,
  inventory_span = int8range(r.inventory_slot, r.inventory_slot + 1, '[)')
FROM rooms r WHERE r.id = b.room_id AND b.inventory_span IS NULL;
ALTER TABLE bookings ALTER COLUMN floor_number SET NOT NULL;
ALTER TABLE bookings ALTER COLUMN inventory_span SET NOT NULL;

CREATE OR REPLACE FUNCTION set_booking_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected rooms%ROWTYPE;
BEGIN
  IF NEW.room_id IS NULL THEN
    IF NEW.floor_number IS NULL OR NEW.floor_number NOT IN (1, 2) OR
      NOT EXISTS (SELECT 1 FROM rooms WHERE floor_number = NEW.floor_number) THEN
      RAISE EXCEPTION 'Choose a floor with registered rooms' USING ERRCODE = '23514';
    END IF;
    NEW.inventory_span := int8range(NULL, NULL, '()');
  ELSE
    SELECT * INTO STRICT selected FROM rooms WHERE id = NEW.room_id;
    NEW.floor_number := selected.floor_number;
    NEW.inventory_span := int8range(selected.inventory_slot, selected.inventory_slot + 1, '[)');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS booking_inventory ON bookings;
CREATE TRIGGER booking_inventory BEFORE INSERT OR UPDATE OF room_id, floor_number, inventory_span
ON bookings FOR EACH ROW EXECUTE FUNCTION set_booking_inventory();

CREATE OR REPLACE FUNCTION protect_room_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inventory_slot IS DISTINCT FROM OLD.inventory_slot THEN
    RAISE EXCEPTION 'Room inventory slot cannot change' USING ERRCODE = '23514';
  END IF;
  IF NEW.floor_number IS DISTINCT FROM OLD.floor_number AND EXISTS (
    SELECT 1 FROM bookings WHERE status IN ('pending', 'confirmed') AND
      (room_id = OLD.id OR (room_id IS NULL AND floor_number IN (OLD.floor_number, NEW.floor_number)))
  ) THEN
    RAISE EXCEPTION 'Cannot move a room with active room or floor reservations' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS room_inventory ON rooms;
CREATE TRIGGER room_inventory BEFORE UPDATE OF floor_number, inventory_slot ON rooms
FOR EACH ROW EXECUTE FUNCTION protect_room_inventory();

-- Pending requests remain reserved until staff confirm or cancel.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_count INT NOT NULL DEFAULT 1 CHECK (guest_count > 0);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS request_key UUID UNIQUE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_choice TEXT NOT NULL DEFAULT 'advance' CHECK (payment_choice IN ('advance', 'full'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS advance_percent INT NOT NULL DEFAULT 30 CHECK (advance_percent BETWEEN 1 AND 100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= total_price);
CREATE TABLE IF NOT EXISTS booking_payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  previous_amount NUMERIC(10,2) NOT NULL,
  verified_amount NUMERIC(10,2) NOT NULL,
  reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE booking_payment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex');
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_status_token ON bookings(status_token);
UPDATE bookings SET hold_expires_at = NULL WHERE status = 'pending' AND hold_expires_at IS NOT NULL;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired'));



-- Only pending and confirmed stays block availability.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap_v2'
    AND conrelid = 'bookings'::regclass) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap_v2 EXCLUDE USING gist (
      room_id WITH =, daterange(check_in, check_out, '[)') WITH &&
    ) WHERE (status IN ('pending', 'confirmed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_floor_overlap'
    AND conrelid = 'bookings'::regclass) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_floor_overlap EXCLUDE USING gist (
      floor_number WITH =, inventory_span WITH &&, daterange(check_in, check_out, '[)') WITH &&
    ) WHERE (status IN ('pending', 'confirmed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS booking_notifications (
  booking_id UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INT NOT NULL DEFAULT 0,
  payload JSONB,
  sent_at TIMESTAMPTZ,
  provider_id TEXT,
  last_error TEXT
);

-- Guests use the Express API. Do not expose records through Supabase's public Data API.
-- The server connects as the database owner (postgres), which bypasses RLS.
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_notifications ENABLE ROW LEVEL SECURITY;
