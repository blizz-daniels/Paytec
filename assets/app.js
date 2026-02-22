const menuButton = document.getElementById('menuButton');
const nav = document.getElementById('mainNav');

if (menuButton && nav) {
  menuButton.addEventListener('click', () => {
    nav.classList.toggle('open');
  });
}

async function toggleTeacherLinks() {
  const teacherLinks = document.querySelectorAll('[data-role-link="teacher"]');
  if (!teacherLinks.length) {
    return;
  }

  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) {
      return;
    }

    const user = await response.json();
    const canSeeTeacherLink = user && (user.role === 'teacher' || user.role === 'admin');
    if (!canSeeTeacherLink) {
      return;
    }

    teacherLinks.forEach((link) => {
      link.hidden = false;
    });
  } catch (_err) {
    // Keep links hidden if role lookup fails.
  }
}

toggleTeacherLinks();

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
