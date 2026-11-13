const crypto = require('crypto');

const sessions = new Map();
const attempts = new Map();
const ttl = 8 * 60 * 60 * 1000;
const cookieName = 'waduge_session';
const digest = value => crypto.createHash('sha256').update(value).digest();

function token(req) {
  return (req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

function authenticated(req) {
  const expires = sessions.get(token(req));
  return Boolean(expires && expires > Date.now());
}

function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!authenticated(req)) return res.status(401).json({ error: 'Please sign in to the admin portal.' });
  next();
}

function sameOrigin(req, res, next) {
  if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Cross-origin requests are not permitted.' });
  }
  next();
}

function registerAuth(app) {
  const options = { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/' };
  app.use('/api/admin', sameOrigin);
  app.get('/api/admin/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ authenticated: authenticated(req) });
  });
  app.post('/api/admin/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const password = process.env.ADMIN_PASSWORD;
    if (!password) return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_PASSWORD on the server.' });
    const key = req.ip;
    const previous = attempts.get(key);
    if (previous && previous.until > Date.now() && previous.count >= 5) {
      res.set('Retry-After', String(Math.ceil((previous.until - Date.now()) / 1000)));
      return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
    }
    const supplied = typeof req.body.password === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(digest(supplied), digest(password))) {
      const entry = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 15 * 60 * 1000 };
      entry.count++;
      attempts.set(key, entry);
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }
    attempts.delete(key);
    sessions.delete(token(req));
    const session = crypto.randomBytes(32).toString('hex');
    sessions.set(session, Date.now() + ttl);
    res.cookie(cookieName, session, { ...options, maxAge: ttl });
    res.json({ success: true });
  });
  app.post('/api/admin/logout', (req, res) => {
    sessions.delete(token(req));
    res.clearCookie(cookieName, options);
    res.json({ success: true });
  });
}

const cleanup = setInterval(() => {
  for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
  for (const [key, entry] of attempts) if (entry.until <= Date.now()) attempts.delete(key);
}, 60000);
cleanup.unref();

module.exports = { registerAuth, requireAdmin, sameOrigin };
