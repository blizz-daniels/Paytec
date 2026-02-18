function setStatus(id, message, isError) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.style.color = isError ? "#a52828" : "#1f2333";
}

async function uploadRoster(inputId, endpoint, statusId, successLabel) {
  const input = document.getElementById(inputId);
  if (!input || !input.files || !input.files[0]) {
    setStatus(statusId, "Select a CSV file first.", true);
    return;
  }

  const csvText = await input.files[0].text();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ csvText }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (_err) {
    // Keep default payload.
  }

  if (!response.ok) {
    throw new Error(payload.error || "Import failed.");
  }

  const imported = Number(payload.imported || 0);
  setStatus(statusId, `${successLabel}: ${imported} record(s) imported.`, false);
}

const studentForm = document.getElementById("studentImportForm");
if (studentForm) {
  studentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("studentImportStatus", "Importing students...", false);
    try {
      await uploadRoster("studentCsv", "/api/admin/import/students", "studentImportStatus", "Student import completed");
      studentForm.reset();
    } catch (err) {
      setStatus("studentImportStatus", err.message, true);
    }
  });
}

const teacherForm = document.getElementById("teacherImportForm");
if (teacherForm) {
  teacherForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("teacherImportStatus", "Importing teachers...", false);
    try {
      await uploadRoster("teacherCsv", "/api/admin/import/teachers", "teacherImportStatus", "Teacher import completed");
      teacherForm.reset();
    } catch (err) {
      setStatus("teacherImportStatus", err.message, true);
    }
  });
}
