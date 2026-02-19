const profileSection = document.getElementById('homeProfile');
if (!profileSection) {
  return;
}

const heroNameEl = document.getElementById('homeStudentName');
const heroNicknameEl = document.getElementById('profileNicknameValue');
const heroAvatarImg = document.getElementById('profileHeroImage');
const heroAvatarInitial = document.getElementById('profileHeroInitial');
const previewAvatarImg = document.getElementById('profilePreviewImage');
const previewAvatarInitial = document.getElementById('profilePreviewInitial');
const previewNameEl = document.getElementById('profilePreviewName');
const previewNicknameEl = document.getElementById('profilePreviewNickname');
const nicknameInput = document.getElementById('profileNicknameInput');
const pictureInput = document.getElementById('profilePictureInput');
const form = document.getElementById('profileForm');
const statusNode = document.getElementById('profileFormStatus');
const resetButton = document.getElementById('profileResetButton');

let currentProfile = null;

function setStatus(message, isError = false) {
  if (!statusNode) {
    return;
  }
  statusNode.textContent = message;
  statusNode.style.color = isError ? '#a52828' : 'var(--muted)';
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
  initialEl.textContent = fallbackName ? fallbackName.charAt(0).toUpperCase() : '';
}

function refreshPreview() {
  const nickname = nicknameInput?.value.trim();
  const imageUrl = pictureInput?.value.trim();
  const fallbackName =
    currentProfile?.displayName || heroNameEl?.textContent || 'Profile preview';

  if (previewNicknameEl) {
    previewNicknameEl.textContent = nickname || 'No nickname yet';
  }
  if (previewNameEl) {
    previewNameEl.textContent = fallbackName;
  }
  updateAvatar(previewAvatarImg, previewAvatarInitial, imageUrl || null, fallbackName);
}

async function loadProfile(options = {}) {
  const { showStatus = false } = options;
  try {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error('Failed to load profile data.');
    }
    currentProfile = await response.json();
    const displayName = currentProfile.displayName || currentProfile.username || 'Student';
    if (heroNameEl) {
      heroNameEl.textContent = displayName;
    }
    if (heroNicknameEl) {
      heroNicknameEl.textContent = currentProfile.nickname || 'Add a nickname';
    }
    if (previewNameEl) {
      previewNameEl.textContent = displayName;
    }
    if (previewNicknameEl) {
      previewNicknameEl.textContent = currentProfile.nickname || 'No nickname yet';
    }
    if (nicknameInput) {
      nicknameInput.value = currentProfile.nickname || '';
    }
    if (pictureInput) {
      pictureInput.value = currentProfile.profileImageUrl || '';
    }
    updateAvatar(heroAvatarImg, heroAvatarInitial, currentProfile.profileImageUrl || null, displayName);
    refreshPreview();
    if (showStatus) {
      setStatus('Profile updated.', false);
    } else {
      setStatus('', false);
    }
  } catch (err) {
    setStatus('Unable to load profile right now.', true);
  }
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('Saving profile...', false);
    const payload = {
      nickname: nicknameInput?.value || '',
      profileImageUrl: pictureInput?.value || '',
    };
    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Could not save profile.');
      }
      await loadProfile({ showStatus: true });
    } catch (err) {
      setStatus(err?.message || 'Something went wrong.', true);
    }
  });
}

if (resetButton) {
  resetButton.addEventListener('click', async () => {
    await loadProfile();
    setStatus('Changes discarded.', false);
  });
}

[nicknameInput, pictureInput].forEach((input) => {
  if (!input) {
    return;
  }
  input.addEventListener('input', () => {
    refreshPreview();
  });
});

loadProfile();
