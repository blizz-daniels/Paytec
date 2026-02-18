function setStatus(id, message, isError) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.style.color = isError ? "#a52828" : "#1f2333";
}

async function submitJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = "Request failed.";
    try {
      const data = await response.json();
      if (data && data.error) {
        message = data.error;
      }
    } catch (_err) {
      // keep fallback message
    }
    throw new Error(message);
  }
}

const notificationForm = document.getElementById("notificationForm");
if (notificationForm) {
  notificationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("notificationStatus", "Publishing...", false);

    const payload = {
      title: document.getElementById("notificationTitle").value.trim(),
      category: document.getElementById("notificationCategory").value.trim(),
      body: document.getElementById("notificationBody").value.trim(),
      isUrgent: document.getElementById("notificationUrgent").checked,
    };

    try {
      await submitJson("/api/notifications", payload);
      notificationForm.reset();
      document.getElementById("notificationCategory").value = "General";
      setStatus("notificationStatus", "Notification published.", false);
    } catch (err) {
      setStatus("notificationStatus", err.message, true);
    }
  });
}

const handoutForm = document.getElementById("handoutForm");
if (handoutForm) {
  handoutForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("handoutStatus", "Saving...", false);

    const payload = {
      title: document.getElementById("handoutTitle").value.trim(),
      description: document.getElementById("handoutDescription").value.trim(),
      fileUrl: document.getElementById("handoutUrl").value.trim(),
    };

    try {
      await submitJson("/api/handouts", payload);
      handoutForm.reset();
      setStatus("handoutStatus", "Handout saved.", false);
    } catch (err) {
      setStatus("handoutStatus", err.message, true);
    }
  });
}

const paymentForm = document.getElementById("paymentForm");
if (paymentForm) {
  paymentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("paymentStatus", "Publishing...", false);

    const payload = {
      title: document.getElementById("paymentTitle").value.trim(),
      description: document.getElementById("paymentDescription").value.trim(),
      paymentUrl: document.getElementById("paymentUrl").value.trim(),
    };

    try {
      await submitJson("/api/payment-links", payload);
      paymentForm.reset();
      setStatus("paymentStatus", "Payment link published.", false);
    } catch (err) {
      setStatus("paymentStatus", err.message, true);
    }
  });
}

const sharedFileForm = document.getElementById("sharedFileForm");
if (sharedFileForm) {
  sharedFileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("sharedFileStatus", "Publishing...", false);

    const payload = {
      title: document.getElementById("sharedFileTitle").value.trim(),
      description: document.getElementById("sharedFileDescription").value.trim(),
      fileUrl: document.getElementById("sharedFileUrl").value.trim(),
    };

    try {
      await submitJson("/api/shared-files", payload);
      sharedFileForm.reset();
      setStatus("sharedFileStatus", "Shared file published.", false);
    } catch (err) {
      setStatus("sharedFileStatus", err.message, true);
    }
  });
}
