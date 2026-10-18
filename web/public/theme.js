// Applies a saved light/dark choice before first paint (external file: the CSP forbids inline scripts).
try {
  var t = localStorage.getItem("mt:theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
