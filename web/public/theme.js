// Apply the saved/system theme before first paint (external file so the CSP can forbid inline scripts).
try {
  var t = localStorage.getItem("apex-theme");
  if (t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.classList.add("dark");
} catch (e) {}
