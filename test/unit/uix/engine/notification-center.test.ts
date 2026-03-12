import { describe, it, expect, beforeEach } from "vitest";
import {
  createNotificationCenter,
} from "../../../../src/uix/engine/notification-center.js";
import type {
  NotificationCenter,
  Notification,
  NotificationCategoryPreference,
} from "../../../../src/uix/engine/notification-center.js";

// ─── Fixtures ───

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "notif-1",
    title: "Test Notification",
    body: "This is a test notification.",
    category: "system",
    priority: "normal",
    read: false,
    dismissed: false,
    createdAt: "2026-02-24T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ───

describe("NotificationCenter", () => {
  let center: NotificationCenter;

  beforeEach(() => {
    center = createNotificationCenter();
  });

  describe("notifications CRUD", () => {
    it("adds and retrieves a notification", () => {
      const n = makeNotification();
      center.addNotification(n);
      expect(center.getNotification("notif-1")).toEqual(n);
    });

    it("returns undefined for unknown notification", () => {
      expect(center.getNotification("unknown")).toBeUndefined();
    });

    it("lists notifications newest first", () => {
      center.addNotification(makeNotification({ id: "old", createdAt: "2026-02-24T09:00:00.000Z" }));
      center.addNotification(makeNotification({ id: "new", createdAt: "2026-02-24T11:00:00.000Z" }));

      const list = center.getNotifications();
      expect(list.map((n) => n.id)).toEqual(["new", "old"]);
    });

    it("deletes a notification", () => {
      center.addNotification(makeNotification());
      expect(center.deleteNotification("notif-1")).toBe(true);
      expect(center.getNotification("notif-1")).toBeUndefined();
    });

    it("returns false when deleting unknown notification", () => {
      expect(center.deleteNotification("unknown")).toBe(false);
    });
  });

  describe("filtering", () => {
    it("filters by category", () => {
      center.addNotification(makeNotification({ id: "sys", category: "system" }));
      center.addNotification(makeNotification({ id: "wf", category: "workflow" }));

      const list = center.getNotifications({ category: "system" });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("sys");
    });

    it("filters by read status", () => {
      center.addNotification(makeNotification({ id: "unread", read: false }));
      center.addNotification(makeNotification({ id: "read", read: true }));

      const unread = center.getNotifications({ read: false });
      expect(unread).toHaveLength(1);
      expect(unread[0].id).toBe("unread");
    });

    it("filters by priority", () => {
      center.addNotification(makeNotification({ id: "high", priority: "high" }));
      center.addNotification(makeNotification({ id: "low", priority: "low" }));

      const high = center.getNotifications({ priority: "high" });
      expect(high).toHaveLength(1);
      expect(high[0].id).toBe("high");
    });

    it("filters by after timestamp", () => {
      center.addNotification(makeNotification({ id: "old", createdAt: "2026-02-23T10:00:00.000Z" }));
      center.addNotification(makeNotification({ id: "new", createdAt: "2026-02-25T10:00:00.000Z" }));

      const after = center.getNotifications({ after: "2026-02-24T00:00:00.000Z" });
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe("new");
    });

    it("excludes dismissed notifications", () => {
      center.addNotification(makeNotification({ id: "active" }));
      center.addNotification(makeNotification({ id: "dismissed", dismissed: true }));

      const list = center.getNotifications();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("active");
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        center.addNotification(makeNotification({ id: `n-${i}`, createdAt: `2026-02-24T1${i}:00:00.000Z` }));
      }
      const list = center.getNotifications({ limit: 2 });
      expect(list).toHaveLength(2);
    });
  });

  describe("read/unread management", () => {
    it("marks a notification as read", () => {
      center.addNotification(makeNotification({ id: "n1" }));
      expect(center.markAsRead("n1")).toBe(true);
      expect(center.getNotification("n1")!.read).toBe(true);
      expect(center.getNotification("n1")!.readAt).toBeDefined();
    });

    it("returns false when marking already-read notification", () => {
      center.addNotification(makeNotification({ id: "n1", read: true }));
      expect(center.markAsRead("n1")).toBe(false);
    });

    it("marks all as read", () => {
      center.addNotification(makeNotification({ id: "n1" }));
      center.addNotification(makeNotification({ id: "n2" }));
      center.addNotification(makeNotification({ id: "n3", read: true }));

      const count = center.markAllAsRead();
      expect(count).toBe(2);
      expect(center.getNotification("n1")!.read).toBe(true);
      expect(center.getNotification("n2")!.read).toBe(true);
    });

    it("marks all as read within category", () => {
      center.addNotification(makeNotification({ id: "sys", category: "system" }));
      center.addNotification(makeNotification({ id: "wf", category: "workflow" }));

      const count = center.markAllAsRead("system");
      expect(count).toBe(1);
      expect(center.getNotification("sys")!.read).toBe(true);
      expect(center.getNotification("wf")!.read).toBe(false);
    });
  });

  describe("dismiss", () => {
    it("dismisses a notification", () => {
      center.addNotification(makeNotification({ id: "n1" }));
      expect(center.dismissNotification("n1")).toBe(true);
      expect(center.getNotification("n1")!.dismissed).toBe(true);
    });

    it("returns false when dismissing already-dismissed notification", () => {
      center.addNotification(makeNotification({ id: "n1", dismissed: true }));
      expect(center.dismissNotification("n1")).toBe(false);
    });
  });

  describe("clearAll", () => {
    it("clears all notifications", () => {
      center.addNotification(makeNotification({ id: "n1" }));
      center.addNotification(makeNotification({ id: "n2" }));
      const count = center.clearAll();
      expect(count).toBe(2);
      expect(center.getNotifications()).toHaveLength(0);
    });

    it("clears only specified category", () => {
      center.addNotification(makeNotification({ id: "sys", category: "system" }));
      center.addNotification(makeNotification({ id: "wf", category: "workflow" }));
      const count = center.clearAll("system");
      expect(count).toBe(1);
      expect(center.getNotifications()).toHaveLength(1);
    });
  });

  describe("summary", () => {
    it("returns correct unread summary", () => {
      center.addNotification(makeNotification({ id: "n1", category: "system" }));
      center.addNotification(makeNotification({ id: "n2", category: "workflow" }));
      center.addNotification(makeNotification({ id: "n3", category: "system", read: true }));
      center.addNotification(makeNotification({ id: "n4", category: "security", priority: "urgent" }));

      const summary = center.getSummary();
      expect(summary.totalUnread).toBe(3);
      expect(summary.byCategory.system).toBe(1);
      expect(summary.byCategory.workflow).toBe(1);
      expect(summary.byCategory.security).toBe(1);
      expect(summary.hasUrgent).toBe(true);
    });

    it("reports no urgent when none exist", () => {
      center.addNotification(makeNotification({ id: "n1", priority: "normal" }));
      expect(center.getSummary().hasUrgent).toBe(false);
    });

    it("returns zero counts when empty", () => {
      const summary = center.getSummary();
      expect(summary.totalUnread).toBe(0);
      expect(summary.hasUrgent).toBe(false);
    });
  });

  describe("preferences", () => {
    it("sets and retrieves a preference", () => {
      const pref: NotificationCategoryPreference = {
        category: "system",
        inApp: true,
        email: false,
        push: true,
        minPriority: "normal",
      };
      center.setPreference(pref);
      expect(center.getPreference("system")).toEqual(pref);
    });

    it("returns undefined for unset preference", () => {
      expect(center.getPreference("billing")).toBeUndefined();
    });

    it("lists all preferences", () => {
      center.setPreference({ category: "system", inApp: true, email: true, push: true, minPriority: "low" });
      center.setPreference({ category: "workflow", inApp: true, email: false, push: false, minPriority: "high" });
      expect(center.getAllPreferences()).toHaveLength(2);
    });
  });

  describe("shouldDeliver", () => {
    it("delivers when no preference is set", () => {
      expect(center.shouldDeliver("system", "low")).toBe(true);
    });

    it("blocks delivery when inApp is disabled", () => {
      center.setPreference({ category: "system", inApp: false, email: true, push: true, minPriority: "low" });
      expect(center.shouldDeliver("system", "high")).toBe(false);
    });

    it("blocks delivery when priority is below minimum", () => {
      center.setPreference({ category: "system", inApp: true, email: true, push: true, minPriority: "high" });
      expect(center.shouldDeliver("system", "normal")).toBe(false);
      expect(center.shouldDeliver("system", "high")).toBe(true);
      expect(center.shouldDeliver("system", "urgent")).toBe(true);
    });
  });
});
