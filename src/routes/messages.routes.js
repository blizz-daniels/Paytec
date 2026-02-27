function registerMessageRoutes(app, deps) {
  const {
    requireAuth,
    normalizeIdentifier,
    isValidIdentifier,
    parseResourceId,
    canCreateMessageThreads,
    validateMessageSubjectOrThrow,
    validateMessageBodyOrThrow,
    validateMessageRecipients,
    listMessageThreadSummariesForUser,
    getMessageUnreadCounts,
    getMessageThreadPayloadForUser,
    withSqlTransaction,
    run,
    get,
    getMessageThreadAccess,
    markMessageThreadReadForUser,
    listMessageStudentDirectory,
  } = deps;

  app.get("/api/messages/threads", requireAuth, async (req, res) => {
    const username = normalizeIdentifier(req.session?.user?.username || "");
    if (!username) {
      return res.status(401).json({ error: "Authentication required." });
    }
    try {
      const [threads, unread] = await Promise.all([
        listMessageThreadSummariesForUser(username),
        getMessageUnreadCounts(username),
      ]);
      return res.json({
        threads,
        unread,
      });
    } catch (_err) {
      return res.status(500).json({ error: "Could not load message threads." });
    }
  });

  app.get("/api/messages/threads/:id", requireAuth, async (req, res) => {
    const threadId = parseResourceId(req.params.id);
    if (!threadId) {
      return res.status(400).json({ error: "Invalid message thread ID." });
    }
    const username = normalizeIdentifier(req.session?.user?.username || "");
    if (!username) {
      return res.status(401).json({ error: "Authentication required." });
    }
    try {
      const payload = await getMessageThreadPayloadForUser(threadId, username);
      return res.json(payload);
    } catch (err) {
      if (err && err.status && err.error) {
        return res.status(err.status).json({ error: err.error });
      }
      return res.status(500).json({ error: "Could not load message thread." });
    }
  });

  app.post("/api/messages/threads", requireAuth, async (req, res) => {
    const actorRole = String(req.session?.user?.role || "")
      .trim()
      .toLowerCase();
    if (!canCreateMessageThreads(actorRole)) {
      return res.status(403).json({ error: "Only lecturers or admins can create message threads." });
    }
    const actorUsername = normalizeIdentifier(req.session?.user?.username || "");
    if (!actorUsername || !isValidIdentifier(actorUsername)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    try {
      const subject = validateMessageSubjectOrThrow(req.body?.subject || "");
      const messageBody = validateMessageBodyOrThrow(req.body?.message || "");
      const recipients = await validateMessageRecipients(req.body?.recipients);

      const result = await withSqlTransaction(async () => {
        const threadInsert = await run(
          `
            INSERT INTO message_threads (subject, created_by, created_at, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `,
          [subject || null, actorUsername]
        );
        const threadId = Number(threadInsert.lastID || 0);

        const participants = [{ username: actorUsername, role: actorRole }];
        const seenParticipants = new Set([actorUsername]);
        recipients.forEach((username) => {
          if (seenParticipants.has(username)) {
            return;
          }
          seenParticipants.add(username);
          participants.push({
            username,
            role: "student",
          });
        });

        for (const participant of participants) {
          await run(
            `
              INSERT INTO message_participants (thread_id, username, role, joined_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `,
            [threadId, participant.username, participant.role]
          );
        }

        const messageInsert = await run(
          `
            INSERT INTO messages (thread_id, sender_username, sender_role, body, created_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          `,
          [threadId, actorUsername, actorRole, messageBody]
        );
        const messageId = Number(messageInsert.lastID || 0);

        await run(
          `
            UPDATE message_participants
            SET last_read_message_id = ?,
                last_read_at = CURRENT_TIMESTAMP
            WHERE thread_id = ?
              AND username = ?
          `,
          [messageId, threadId, actorUsername]
        );
        await run("UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [threadId]);

        return {
          threadId,
          messageId,
        };
      });

      const payload = await getMessageThreadPayloadForUser(result.threadId, actorUsername);
      return res.status(201).json({
        ok: true,
        threadId: result.threadId,
        messageId: result.messageId,
        ...payload,
      });
    } catch (err) {
      if (err && err.status && err.error) {
        return res.status(err.status).json({ error: err.error });
      }
      return res.status(500).json({ error: "Could not create message thread." });
    }
  });

  app.post("/api/messages/threads/:id/messages", requireAuth, async (req, res) => {
    const threadId = parseResourceId(req.params.id);
    if (!threadId) {
      return res.status(400).json({ error: "Invalid message thread ID." });
    }
    const actorUsername = normalizeIdentifier(req.session?.user?.username || "");
    const actorRole = String(req.session?.user?.role || "")
      .trim()
      .toLowerCase();
    if (!actorUsername || !isValidIdentifier(actorUsername)) {
      return res.status(401).json({ error: "Authentication required." });
    }

    try {
      const messageBody = validateMessageBodyOrThrow(req.body?.message || "");
      await getMessageThreadAccess(threadId, actorUsername);
      const inserted = await withSqlTransaction(async () => {
        const messageInsert = await run(
          `
            INSERT INTO messages (thread_id, sender_username, sender_role, body, created_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          `,
          [threadId, actorUsername, actorRole, messageBody]
        );
        const messageId = Number(messageInsert.lastID || 0);
        await run("UPDATE message_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [threadId]);
        await run(
          `
            UPDATE message_participants
            SET last_read_message_id = ?,
                last_read_at = CURRENT_TIMESTAMP
            WHERE thread_id = ?
              AND username = ?
          `,
          [messageId, threadId, actorUsername]
        );
        return messageId;
      });

      const messageRow = await get(
        `
          SELECT id, thread_id, sender_username, sender_role, body, created_at
          FROM messages
          WHERE id = ?
          LIMIT 1
        `,
        [inserted]
      );
      return res.status(201).json({
        ok: true,
        message: {
          id: Number(messageRow?.id || 0),
          thread_id: Number(messageRow?.thread_id || threadId),
          sender_username: String(messageRow?.sender_username || actorUsername),
          sender_role: String(messageRow?.sender_role || actorRole),
          body: String(messageRow?.body || messageBody),
          created_at: messageRow?.created_at || "",
        },
      });
    } catch (err) {
      if (err && err.status && err.error) {
        return res.status(err.status).json({ error: err.error });
      }
      return res.status(500).json({ error: "Could not send message." });
    }
  });

  app.post("/api/messages/threads/:id/read", requireAuth, async (req, res) => {
    const threadId = parseResourceId(req.params.id);
    if (!threadId) {
      return res.status(400).json({ error: "Invalid message thread ID." });
    }
    const username = normalizeIdentifier(req.session?.user?.username || "");
    if (!username) {
      return res.status(401).json({ error: "Authentication required." });
    }
    try {
      await getMessageThreadAccess(threadId, username);
      const lastReadMessageId = await markMessageThreadReadForUser(threadId, username);
      const unread = await getMessageUnreadCounts(username);
      return res.json({
        ok: true,
        thread_id: threadId,
        last_read_message_id: lastReadMessageId,
        unread,
      });
    } catch (err) {
      if (err && err.status && err.error) {
        return res.status(err.status).json({ error: err.error });
      }
      return res.status(500).json({ error: "Could not update read state." });
    }
  });

  app.get("/api/messages/unread-count", requireAuth, async (req, res) => {
    const username = normalizeIdentifier(req.session?.user?.username || "");
    if (!username) {
      return res.status(401).json({ error: "Authentication required." });
    }
    try {
      const unread = await getMessageUnreadCounts(username);
      return res.json(unread);
    } catch (_err) {
      return res.status(500).json({ error: "Could not load unread count." });
    }
  });

  app.get("/api/messages/students", requireAuth, async (req, res) => {
    const actorRole = String(req.session?.user?.role || "")
      .trim()
      .toLowerCase();
    if (!canCreateMessageThreads(actorRole)) {
      return res.status(403).json({ error: "Only lecturers or admins can list student recipients." });
    }
    try {
      const students = await listMessageStudentDirectory();
      return res.json({ students });
    } catch (_err) {
      return res.status(500).json({ error: "Could not load students." });
    }
  });
}

module.exports = {
  registerMessageRoutes,
};