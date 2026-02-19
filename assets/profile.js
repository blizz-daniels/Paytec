const nav = document.getElementById("mainNav") || document.querySelector(".nav-links");
if (!nav) {
  return;
}

const profileButton = document.createElement("button");
profileButton.type = "button";
profileButton.className = "profile-trigger";
profileButton.id = "profileToggleButton";
profileButton.textContent = "Profile";
const logoutLink = nav.querySelector(".logout-btn");
if (logoutLink) {
  nav.insertBefore(profileButton, logoutLink);
} else {
  nav.appendChild(profileButton);
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
      <a href="/logout" class="logout-btn">Log out</a>
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

let profileData = null;

function setStatus(message, isError = false) {
  if (!statusNode) {
    return;
  }
  statusNode.textContent = message;
  statusNode.style.color = isError ? "#a52828" : "var(--muted)";
}

function updateAvatar(imageEl, initialEl, imageUrl, fallbackName) {
  if (!imageEl || !initialEl) {
    return;
  }
  if (imageUrl) {
    imageEl.src = imageUrl;
    imageEl.hidden = false;
    initialEl.hidden = true;
    return;
  }
  imageEl.hidden = true;
  initialEl.hidden = false;
  const initial = fallbackName ? fallbackName.charAt(0).toUpperCase() : "";
  initialEl.textContent = initial;
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
  if (profileImageEl && profileInitialEl) {
    updateAvatar(profileImageEl, profileInitialEl, profile.profileImageUrl || null, displayName);
  }
}

function openPanel() {
  panel.classList.add("profile-panel--open");
  document.body.classList.add("has-profile-panel");
}

function closePanel() {
  panel.classList.remove("profile-panel--open");
  document.body.classList.remove("has-profile-panel");
}

function togglePanel() {
  if (panel.classList.contains("profile-panel--open")) {
    closePanel();
  } else {
    openPanel();
  }
}

async function loadProfile({ showStatus = false } = {}) {
  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error("Could not load profile.");
    }
    const data = await response.json();
    applyProfile(data);
    if (showStatus) {
      setStatus("Profile saved.", false);
    } else {
      setStatus("", false);
    }
  } catch (err) {
    setStatus("Unable to load profile right now.", true);
  }
}

profileButton.addEventListener("click", () => {
  loadProfile();
  openPanel();
});

panel.addEventListener("click", (event) => {
  if ((event.target instanceof HTMLElement) && event.target.dataset.action === "close") {
    closePanel();
  }
});

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
      return;
    }
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
    }
  });
}

if (avatarForm) {
  avatarForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = avatarInput?.files?.[0];
    if (!file) {
      setStatus("Select an image to upload.", true);
      return;
    }
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
      if (avatarInput) {
        avatarInput.value = "";
      }
      await loadProfile({ showStatus: true });
    } catch (err) {
      setStatus(err?.message || "Upload failed.", true);
    }
  });
}

loadProfile();
