(() => {
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  let csrfTokenPromise = null;
  function clearCsrfTokenCache() {
    csrfTokenPromise = null;
  }

  async function loadCsrfToken() {
    if (!csrfTokenPromise) {
      csrfTokenPromise = fetch("/api/csrf-token", {
        credentials: "same-origin",
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error("Could not load CSRF token.");
          }
          const payload = await response.json();
          if (!payload || !payload.csrfToken) {
            throw new Error("Missing CSRF token.");
          }
          return payload.csrfToken;
        })
        .catch((err) => {
          csrfTokenPromise = null;
          throw err;
        });
    }
    return csrfTokenPromise;
  }

  function getRequestMethod(input, init) {
    if (init && init.method) {
      return String(init.method).toUpperCase();
    }
    if (input && typeof input === "object" && "method" in input && input.method) {
      return String(input.method).toUpperCase();
    }
    return "GET";
  }

  function getRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input === "object" && "url" in input) {
      return input.url;
    }
    return "";
  }

  function isSameOriginUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);
      return url.origin === window.location.origin;
    } catch (_err) {
      return false;
    }
  }

  const originalFetch = window.fetch.bind(window);
  function isInvalidCsrfResponse(response, payload) {
    if (!response || response.status !== 403) {
      return false;
    }
    const errorText = String(payload?.error || "").toLowerCase();
    return errorText.includes("csrf");
  }

  async function parseJsonSafe(response) {
    try {
      return await response.clone().json();
    } catch (_err) {
      return null;
    }
  }

  window.fetch = async (input, init = {}) => {
    const method = getRequestMethod(input, init);
    const requestUrl = getRequestUrl(input);
    if (SAFE_METHODS.has(method) || !isSameOriginUrl(requestUrl)) {
      return originalFetch(input, init);
    }

    const sendWithToken = async (token) => {
      const headers = new Headers(init.headers || {});
      headers.set("X-CSRF-Token", token);
      return originalFetch(input, {
        ...init,
        headers,
        credentials: init.credentials || "same-origin",
      });
    };

    let csrfToken = await loadCsrfToken();
    let response = await sendWithToken(csrfToken);
    const payload = await parseJsonSafe(response);
    if (!isInvalidCsrfResponse(response, payload)) {
      return response;
    }

    clearCsrfTokenCache();
    csrfToken = await loadCsrfToken();
    response = await sendWithToken(csrfToken);
    return response;
  };

  async function bindCsrfToForms() {
    const forms = document.querySelectorAll("form");
    if (!forms.length) {
      return;
    }

    let csrfToken = "";
    try {
      csrfToken = await loadCsrfToken();
    } catch (_err) {
      return;
    }

    forms.forEach((form) => {
      const method = String(form.getAttribute("method") || "GET").toUpperCase();
      if (SAFE_METHODS.has(method)) {
        return;
      }
      let tokenField = form.querySelector('input[name="_csrf"]');
      if (!tokenField) {
        tokenField = document.createElement("input");
        tokenField.type = "hidden";
        tokenField.name = "_csrf";
        form.appendChild(tokenField);
      }
      tokenField.value = csrfToken;
    });
  }

  window.ensureCsrfToken = loadCsrfToken;
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const method = String(form.getAttribute("method") || "GET").toUpperCase();
    if (SAFE_METHODS.has(method)) {
      return;
    }
    const tokenField = form.querySelector('input[name="_csrf"]');
    if (!tokenField || form.dataset.csrfSubmitting === "true") {
      return;
    }

    event.preventDefault();
    form.dataset.csrfSubmitting = "true";
    try {
      clearCsrfTokenCache();
      tokenField.value = await loadCsrfToken();
      form.submit();
    } catch (_err) {
      // Let the form remain on the page if token loading fails.
    } finally {
      form.dataset.csrfSubmitting = "false";
    }
  });
  window.addEventListener("DOMContentLoaded", () => {
    bindCsrfToForms();
  });
  window.addEventListener("pageshow", () => {
    clearCsrfTokenCache();
    bindCsrfToForms();
  });
})();