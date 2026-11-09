// Institution chooser: sends the visitor to /t/<slug>/. The server decides whether it exists.
const form = document.getElementById('start-form');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const slug = form.slug.value.trim().toLowerCase();
  const slot = document.getElementById('err-slug');
  if (!SLUG.test(slug)) {
    slot.textContent = 'Use 3-30 lowercase letters, numbers or hyphens.';
    return;
  }
  location.assign('/t/' + slug + '/');
});
