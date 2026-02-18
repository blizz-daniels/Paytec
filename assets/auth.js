const params = new URLSearchParams(window.location.search);
const error = params.get("error");
const authError = document.getElementById("authError");

if (!authError || !error) {
  // Nothing to render for this page state.
} else {
  const loginMessages = {
    invalid: "Invalid username or password.",
    session: "Could not start your session. Try again.",
  };

  const fallback = "Login failed. Please try again.";

  authError.textContent = loginMessages[error] || fallback;
  authError.hidden = false;
}
