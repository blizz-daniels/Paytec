const menuButton = document.getElementById('menuButton');
const nav = document.getElementById('mainNav');

if (menuButton && nav) {
  menuButton.addEventListener('click', () => {
    nav.classList.toggle('open');
  });
}

function normalizePath(pathname) {
  if (!pathname) {
    return "/";
  }
  const clean = pathname.toLowerCase();
  return clean.endsWith("/") && clean.length > 1 ? clean.slice(0, -1) : clean;
}

function getNavItemPath(node) {
  if (!node || node.tagName !== "A") {
    return "";
  }
  const href = node.getAttribute("href") || "";
  if (!href || href.startsWith("#")) {
    return "";
  }
  try {
    const url = new URL(href, window.location.origin);
    return normalizePath(url.pathname);
  } catch (_err) {
    return "";
  }
}

function arrangeSidebarNav() {
  if (!nav) {
    return;
  }

  if (nav.querySelector(".nav-section")) {
    return;
  }

  const topSection = document.createElement("div");
  topSection.className = "nav-section nav-section--top";
  const middleSection = document.createElement("div");
  middleSection.className = "nav-section nav-section--middle";
  const bottomSection = document.createElement("div");
  bottomSection.className = "nav-section nav-section--bottom";

  const homePaths = new Set(["/", "/index.html"]);
  const notificationPaths = new Set(["/notifications.html"]);
  const handoutPaths = new Set(["/handouts.html"]);
  const paymentPaths = new Set(["/payments.html"]);
  const analyticsPaths = new Set(["/analytics", "/analytics.html"]);

  const allChildren = Array.from(nav.children);
  let profileButton = null;
  let themeToggle = null;
  let logoutForm = null;

  allChildren.forEach((node) => {
    if (node.id === "profileToggleButton") {
      profileButton = node;
      return;
    }
    if (node.id === "themeToggleWrap") {
      themeToggle = node;
      return;
    }
    if (node.classList && node.classList.contains("logout-form")) {
      logoutForm = node;
      return;
    }

    const path = getNavItemPath(node);
    if (homePaths.has(path) || notificationPaths.has(path)) {
      topSection.appendChild(node);
      return;
    }
    if (handoutPaths.has(path) || paymentPaths.has(path) || analyticsPaths.has(path)) {
      middleSection.appendChild(node);
      return;
    }
    bottomSection.appendChild(node);
  });

  nav.replaceChildren(topSection, middleSection, bottomSection);

  if (profileButton) {
    bottomSection.appendChild(profileButton);
  }
  if (themeToggle) {
    bottomSection.appendChild(themeToggle);
  }
  if (logoutForm) {
    bottomSection.appendChild(logoutForm);
  }
}

async function toggleTeacherRoleLinks() {
  const teacherLinks = document.querySelectorAll('[data-role-link="lecturer"], [data-role-link="analytics"]');
  if (!teacherLinks.length) {
    return;
  }

  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) {
      return;
    }

    const user = await response.json();
    const canSeeTeacherLinks = user && (user.role === 'teacher' || user.role === 'admin');
    teacherLinks.forEach((link) => {
      link.hidden = !canSeeTeacherLinks;
    });
  } catch (_err) {
    // Keep links hidden if role lookup fails.
  }
}

toggleTeacherRoleLinks();

(function initThemeToggle() {
  const storageKey = "campuspay-theme";
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const savedTheme = localStorage.getItem(storageKey);
  const initialTheme = savedTheme === "dark" || savedTheme === "light" ? savedTheme : prefersDark ? "dark" : "light";

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const toggleInput = document.getElementById("themeToggleButton");
    const toggleLabel = document.getElementById("themeToggleLabel");
    if (toggleInput) {
      const isDark = theme === "dark";
      toggleInput.checked = isDark;
      toggleInput.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    }
    if (toggleLabel) {
      toggleLabel.textContent = theme === "dark" ? "Dark" : "Light";
    }
  }

  applyTheme(initialTheme);

  if (!nav) {
    return;
  }

  let themeWrap = document.getElementById("themeToggleWrap");
  if (!themeWrap) {
    themeWrap = document.createElement("label");
    themeWrap.id = "themeToggleWrap";
    themeWrap.className = "theme-switch";
    themeWrap.innerHTML = `
      <input id="themeToggleButton" type="checkbox" role="switch" />
      <span class="theme-switch__track" aria-hidden="true"></span>
      <span class="theme-switch__icon theme-switch__sun" aria-hidden="true">☀</span>
      <span class="theme-switch__icon theme-switch__moon" aria-hidden="true">☾</span>
      <span id="themeToggleLabel" class="theme-switch__label">Light</span>
    `;
    const profileButton = nav.querySelector("#profileToggleButton");
    if (profileButton) {
      nav.insertBefore(themeWrap, profileButton);
    } else {
      nav.appendChild(themeWrap);
    }
  }

  applyTheme(document.documentElement.getAttribute("data-theme") || initialTheme);
  arrangeSidebarNav();

  const themeInput = document.getElementById("themeToggleButton");
  if (!themeInput) {
    return;
  }
  themeInput.addEventListener("change", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(storageKey, next);
    applyTheme(next);
    if (window.showToast) {
      window.showToast(next === "dark" ? "Dark mode enabled." : "Light mode enabled.", { type: "success" });
    }
  });
})();

(function initToastSystem() {
  const hostId = "toastHost";

  function ensureHost() {
    let host = document.getElementById(hostId);
    if (host) {
      return host;
    }
    host = document.createElement("div");
    host.id = hostId;
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-atomic", "true");
    document.body.appendChild(host);
    return host;
  }

  function closeToast(node) {
    if (!node || !node.parentElement) {
      return;
    }
    node.classList.add("toast--closing");
    window.setTimeout(() => {
      if (node.parentElement) {
        node.remove();
      }
    }, 220);
  }

  window.showToast = function showToast(message, options = {}) {
    if (!message) {
      return { close() {} };
    }
    const { type = "info", duration = 2600, sticky = false } = options;
    const host = ensureHost();
    const toast = document.createElement("div");
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `
      <span class="toast__text"></span>
      <button type="button" class="toast__close" aria-label="Close notification">&times;</button>
    `;
    toast.querySelector(".toast__text").textContent = String(message);
    const closeButton = toast.querySelector(".toast__close");
    closeButton.addEventListener("click", () => closeToast(toast));
    host.appendChild(toast);

    if (!sticky) {
      window.setTimeout(() => closeToast(toast), duration);
    }

    return {
      close() {
        closeToast(toast);
      },
    };
  };
})();
