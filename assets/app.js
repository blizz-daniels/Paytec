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
