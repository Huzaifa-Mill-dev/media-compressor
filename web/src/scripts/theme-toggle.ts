/** Light/dark switch. No saved choice = follow the OS (CSS media query); a click pins the opposite of what is shown. */
const KEY = "mt:theme";
const root = document.documentElement;
const btn = document.getElementById("theme-toggle");

const isDark = () => root.dataset.theme === "dark" || (root.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
const sync = () => btn?.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");

btn?.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  sync();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sync);
sync();
