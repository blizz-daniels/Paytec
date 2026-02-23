window.addEventListener("DOMContentLoaded", () => {
  const nav = document.getElementById("mainNav") || document.querySelector(".nav-links");
  if (!nav) {
    return;
  }

  const profileButtonId = "profileToggleButton";
  let profileButton = document.getElementById(profileButtonId);
  if (!profileButton) {
    profileButton = document.createElement("button");
    profileButton.type = "button";
    profileButton.id = profileButtonId;
    profileButton.className = "profile-trigger";
    profileButton.innerHTML =
      '<img class="nav-link__icon" src="/assets/icons8-profile-24.png" alt="" aria-hidden="true" />Profile';
    const logoutButton = nav.querySelector(".logout-btn");
    if (logoutButton) {
      nav.insertBefore(profileButton, logoutButton);
    } else {
      nav.appendChild(profileButton);
    }
  }

  const panel = document.createElement("div");
  panel.id = "profilePanel";
  panel.className = "profile-panel";
  panel.innerHTML = `
    <div class="profile-panel__backdrop" data-action="close"></div>
    <div class="profile-panel__content" role="dialog" aria-modal="true" aria-label="Profile details">
      <div class="profile-panel__header">
        <div class="profile-panel__avatar" data-profile-avatar>
          <img data-profile-image alt="Profile picture" hidden />
          <span data-profile-initial></span>
        </div>
        <div>
          <p class="profile-panel__name" data-profile-name>Loading...</p>
          <p class="profile-panel__role" data-profile-role></p>
        </div>
        <button type="button" class="profile-panel__close" data-action="close" aria-label="Close profile panel">&times;</button>
      </div>
      <p class="profile-panel__status" data-profile-status aria-live="polite"></p>
      <div class="profile-panel__quick-links">
        <a href="/">Home</a>
        <a href="/notifications.html">Notifications</a>
        <a href="/handouts.html">Handouts</a>
        <a href="/payments.html">Payments</a>
        <form method="post" action="/logout" class="logout-form">
          <input type="hidden" name="_csrf" value="" />
          <button type="submit" class="logout-btn">Log out</button>
        </form>
      </div>
      <form id="profileDisplayForm" class="profile-panel__form">
        <label for="profileDisplayName">Display name</label>
        <input id="profileDisplayName" name="displayName" type="text" maxlength="60" placeholder="How should we call you?" />
        <button type="submit" class="btn">Save name</button>
      </form>
      <form id="profileAvatarForm" class="profile-panel__form">
        <label for="profileAvatarInput">Profile picture (PNG, JPG, WEBP)</label>
        <input id="profileAvatarInput" name="avatar" type="file" accept="image/png,image/jpeg,image/webp" />
        <button type="submit" class="btn btn-secondary">Upload picture</button>
      </form>
    </div>
  `;
  document.body.appendChild(panel);

  const profileNameEl = panel.querySelector("[data-profile-name]");
  const profileRoleEl = panel.querySelector("[data-profile-role]");
  const profileImageEl = panel.querySelector("[data-profile-image]");
  const profileInitialEl = panel.querySelector("[data-profile-initial]");
  const displayNameInput = panel.querySelector("#profileDisplayName");
  const displayForm = panel.querySelector("#profileDisplayForm");
  const avatarForm = panel.querySelector("#profileAvatarForm");
  const avatarInput = panel.querySelector("#profileAvatarInput");
  const statusNode = panel.querySelector("[data-profile-status]");
  const homeGreetingName = document.getElementById("homeGreetingName");
  const homeGreeting = document.querySelector(".home-greeting");
  const backdrop = panel.querySelector("[data-action=\"close\"]");

  let profileData = null;

  function setButtonBusy(button, isBusy, busyLabel) {
    if (!button) {
      return;
    }
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.textContent || "";
    }
    button.disabled = !!isBusy;
    button.textContent = isBusy ? busyLabel : button.dataset.defaultLabel;
  }

  function setStatus(message, isError = false) {
    if (!statusNode) {
      return;
    }
    statusNode.textContent = message;
    statusNode.style.color = isError ? "#a52828" : "var(--muted)";
  }

  function updateAvatar(imageEl, initialEl, imageUrl, fallback) {
    if (!imageEl || !initialEl) {
      return;
    }
    const firstLetter = String(fallback || "").trim().charAt(0).toUpperCase();
    if (imageUrl) {
      imageEl.src = imageUrl;
      imageEl.hidden = false;
      initialEl.hidden = true;
      return;
    }
    imageEl.hidden = true;
    initialEl.hidden = false;
    initialEl.textContent = firstLetter || "?";
  }

  function applyProfile(profile) {
    if (!profile) {
      return;
    }
    profileData = profile;
    const displayName = profile.displayName || profile.username || "Guest";
    if (profileNameEl) {
      profileNameEl.textContent = displayName;
    }
    if (profileRoleEl) {
      const roleText = profile.role
        ? `${profile.role.charAt(0).toUpperCase()}${profile.role.slice(1)}`
        : "Member";
      profileRoleEl.textContent = roleText;
    }
    if (displayNameInput) {
      displayNameInput.value = displayName;
    }
    if (homeGreetingName) {
      homeGreetingName.textContent = displayName;
    }
    if (homeGreeting) {
      homeGreeting.hidden = false;
    }
    updateAvatar(profileImageEl, profileInitialEl, profile.profileImageUrl || null, displayName);
  }

  function openPanel() {
    panel.classList.add("profile-panel--open");
    panel.style.display = "block";
    document.body.classList.add("has-profile-panel");
  }

  function closePanel() {
    panel.classList.remove("profile-panel--open");
    panel.style.display = "none";
    document.body.classList.remove("has-profile-panel");
    setStatus("", false);
  }

  async function loadProfile({ showStatus = false } = {}) {
    try {
      const response = await fetch("/api/me", { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error("Could not load profile.");
      }
      const data = await response.json();
      applyProfile(data);
      setStatus(showStatus ? "Profile saved." : "", false);
      if (showStatus && window.showToast) {
        window.showToast("Profile updated.", { type: "success" });
      }
    } catch (err) {
      setStatus("Unable to load profile right now.", true);
      if (showStatus && window.showToast) {
        window.showToast("Unable to load profile right now.", { type: "error" });
      }
    }
  }

  profileButton.addEventListener("click", () => {
    loadProfile();
    openPanel();
  });

  backdrop?.addEventListener("click", closePanel);
  panel.querySelector(".profile-panel__close")?.addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("profile-panel--open")) {
      closePanel();
    }
  });

  if (displayForm) {
    displayForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = displayNameInput?.value?.trim() || "";
      if (!value) {
        setStatus("Display name cannot be empty.", true);
        if (window.showToast) {
          window.showToast("Display name cannot be empty.", { type: "error" });
        }
        return;
      }
      const submitButton = displayForm.querySelector('button[type="submit"]');
      const loadingToast = window.showToast
        ? window.showToast("Saving profile name...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(submitButton, true, "Saving...");
      setStatus("Saving display name...", false);
      try {
        const response = await fetch("/api/profile", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: value }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Could not save your name.");
        }
        await loadProfile({ showStatus: true });
      } catch (err) {
        setStatus(err?.message || "Could not save display name.", true);
        if (window.showToast) {
          window.showToast(err?.message || "Could not save display name.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  if (avatarForm) {
    avatarForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = avatarInput?.files?.[0];
      if (!file) {
        setStatus("Select an image to upload.", true);
        if (window.showToast) {
          window.showToast("Select an image to upload.", { type: "error" });
        }
        return;
      }
      const submitButton = avatarForm.querySelector('button[type="submit"]');
      const loadingToast = window.showToast
        ? window.showToast("Uploading profile picture...", { type: "loading", sticky: true })
        : null;
      setButtonBusy(submitButton, true, "Uploading...");
      setStatus("Uploading picture...", false);
      const formData = new FormData();
      formData.append("avatar", file);
      try {
        const response = await fetch("/api/profile/avatar", {
          method: "POST",
          credentials: "same-origin",
          body: formData,
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Upload failed.");
        }
        avatarInput.value = "";
        await loadProfile({ showStatus: true });
      } catch (err) {
        setStatus(err?.message || "Upload failed.", true);
        if (window.showToast) {
          window.showToast(err?.message || "Upload failed.", { type: "error" });
        }
      } finally {
        setButtonBusy(submitButton, false, "");
        if (loadingToast) {
          loadingToast.close();
        }
      }
    });
  }

  loadProfile();
});
