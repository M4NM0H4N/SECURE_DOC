// Sets the theme before the page paints (loaded in <head>, no inline script needed).
// Dark is the default; the user's choice (light or dark) is remembered in this browser only.
(function () {
  var theme = 'dark';
  try {
    var saved = localStorage.getItem('docflow-theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (_e) {
    /* storage blocked: stay on the default */
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
