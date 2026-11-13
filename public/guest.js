document.addEventListener('DOMContentLoaded', async () => {
  const year = document.getElementById('currentYear');
  if (year) year.textContent = new Date().getFullYear();
  const gallery = document.getElementById('heroGallery');
  async function initializeGallery() {
    if (!gallery) return;
    const track = gallery.querySelector('.hero-slides');
    const controls = gallery.querySelector('.hero-gallery-controls');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sources = [
      '/assets/87620c0d-955c-428b-8600-10001fd09a52.png',
      '/assets/7f652c8c-14dd-42f2-b783-de8a9d9d03c2.png'
    ];
    const photos = await Promise.all(sources.map(src => new Promise(resolve => {
      const photo = new Image();
      photo.onload = () => resolve(photo);
      photo.onerror = () => resolve(null);
      photo.src = src;
    })));
    const slides = photos.filter(Boolean);
    if (slides.length) {
      gallery.querySelector(':scope > img').hidden = true;
      gallery.classList.add('has-photos');
      gallery.querySelector('figcaption').textContent = 'Gregory Lake and the surrounding hills · Waduge Inn';
      gallery.querySelector('.figure-index').textContent = 'THE HILL COUNTRY';
      slides.forEach((photo, index) => {
        photo.alt = index === 0 ? 'Green hills and Gregory Lake seen from Waduge Inn' : 'Wide view of Gregory Lake and the surrounding hill country';
        photo.className = 'hero-slide';
        photo.draggable = false;
        track.append(photo);
      });
      let active = 0;
      let paused = reducedMotion.matches;
      let timer;
      const pause = controls.querySelector('[data-gallery-pause]');
      function show(index) {
        active = (index + slides.length) % slides.length;
        slides.forEach((photo, i) => {
          photo.style.transform = `translateX(${(i - active) * 100}%)`;
          photo.setAttribute('aria-hidden', String(i !== active));
        });
        controls.querySelector('[data-gallery-count]').textContent = `${active + 1} / ${slides.length}`;
      }
      function schedule() {
        clearInterval(timer);
        if (slides.length > 1 && !paused && !document.hidden && !gallery.matches(':hover') && !gallery.contains(document.activeElement)) timer = setInterval(() => show(active + 1), 5500);
      }
      function move(step) { show(active + step); schedule(); }
      controls.hidden = slides.length < 2;
      controls.querySelector('[data-gallery-prev]').addEventListener('click', () => move(-1));
      controls.querySelector('[data-gallery-next]').addEventListener('click', () => move(1));
      function updatePause() {
        pause.textContent = paused ? 'Play' : 'Pause';
        pause.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
        schedule();
      }
      pause.addEventListener('click', () => { paused = !paused; updatePause(); });
      reducedMotion.addEventListener('change', () => { paused = reducedMotion.matches; updatePause(); });
      track.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }
      });
      let touchX = null;
      track.addEventListener('touchstart', event => { touchX = event.touches[0].clientX; }, { passive: true });
      track.addEventListener('touchend', event => {
        if (touchX !== null) {
          const distance = event.changedTouches[0].clientX - touchX;
          if (Math.abs(distance) > 45) move(distance < 0 ? 1 : -1);
        }
        touchX = null;
      }, { passive: true });
      track.addEventListener('touchcancel', () => { touchX = null; });
      gallery.addEventListener('mouseenter', () => clearInterval(timer));
      gallery.addEventListener('mouseleave', schedule);
      gallery.addEventListener('focusin', () => clearInterval(timer));
      gallery.addEventListener('focusout', () => setTimeout(schedule, 0));
      document.addEventListener('visibilitychange', schedule);
      show(0);
      updatePause();
    }
  }
  initializeGallery();
  const toggle = document.getElementById('mobileMenuBtn');
  const menu = document.getElementById('mobileMenu');
  function closeMenu() {
    menu?.classList.remove('is-open');
    toggle?.setAttribute('aria-expanded', 'false');
    toggle?.setAttribute('aria-label', 'Open navigation');
  }
  toggle?.addEventListener('click', () => {
    const open = menu.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
  menu?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.classList.contains('is-open')) { closeMenu(); toggle.focus(); }
  });
  try {
    const response = await fetch('/api/config');
    if (!response.ok) return;
    const config = await response.json();
    document.querySelectorAll('[data-whatsapp]').forEach(link => {
      if (!config.whatsappNumber) return;
      link.href = `https://wa.me/${config.whatsappNumber}?text=${encodeURIComponent('Hello Waduge Inn! I would like to ask about a stay above Gregory Lake. Please share your location pin and availability.')}`;
      link.classList.remove('hidden');
    });
    const address = document.getElementById('propertyAddress');
    if (address && config.address) address.textContent = config.address;
    for (const [id, value, prefix] of [
      ['propertyMapLink', config.mapsUrl, ''], ['propertyPhoneLink', config.contactPhone, 'tel:'],
      ['propertyEmailLink', config.contactEmail, 'mailto:']
    ]) {
      const link = document.getElementById(id);
      if (!link || !value) continue;
      link.href = prefix + value;
      if (prefix) link.textContent = value;
      link.classList.remove('hidden');
    }
    if (config.whatsappNumber || config.contactPhone || config.contactEmail) document.getElementById('contactFallback')?.classList.add('hidden');
  } catch { /* Rooms and booking remain accessible when contact settings cannot load. */ }
});
