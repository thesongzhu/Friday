/**
 * Notification Center — In-app notification management with
 * read/unread tracking, categories, and user preferences.
 *
 * Provides a centralized store for application notifications
 * with filtering, pagination, and preference-based delivery.
 *
 * @module uix/engine
 */

import type {
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/friday-uix.types.js";

// ─── Types ───

/** Notification urgency level. */
export type NotificationPriority = "low" | "normal" | "high" | "urgent";

/** Notification category for filtering and preference management. */
export type NotificationCategory =
  | "system"
  | "workflow"
  | "integration"
  | "security"
  | "billing"
  | "social"
  | "update";

/** A single notification entry. */
export interface Notification {
  /** Unique notification identifier. */
  id: string;
  /** Notification title. */
  title: string;
  /** Notification body text. */
  body: string;
  /** Category for filtering. */
  category: NotificationCategory;
  /** Priority level. */
  priority: NotificationPriority;
  /** Icon identifier. */
  icon?: string;
  /** Action URL or route path for click-through. */
  actionPath?: string;
  /** Whether this notification has been read. */
  read: boolean;
  /** Whether this notification has been dismissed. */
  dismissed: boolean;
  /** When this notification was created. */
  createdAt: ISODateTime;
  /** When this notification was read (if read). */
  readAt?: ISODateTime;
  /** Source identifier (e.g., workflow ID, integration name). */
  sourceId?: string;
  /** Arbitrary metadata. */
  metadata: JsonObject;
}

/** User preference for a notification category. */
export interface NotificationCategoryPreference {
  /** Category. */
  category: NotificationCategory;
  /** Whether this category is enabled for in-app display. */
  inApp: boolean;
  /** Whether this category is enabled for email delivery. */
  email: boolean;
  /** Whether this category is enabled for push notifications. */
  push: boolean;
  /** Minimum priority level to deliver. Notifications below this are suppressed. */
  minPriority: NotificationPriority;
}

/** Summary of unread notification counts by category. */
export interface NotificationSummary {
  /** Total unread count. */
  totalUnread: number;
  /** Unread count per category. */
  byCategory: Record<NotificationCategory, number>;
  /** Whether there are any urgent unread notifications. */
  hasUrgent: boolean;
}

/** Filter options for listing notifications. */
export interface NotificationFilter {
  /** Filter by category. */
  category?: NotificationCategory;
  /** Filter by read status. */
  read?: boolean;
  /** Filter by priority. */
  priority?: NotificationPriority;
  /** Filter notifications created after this timestamp. */
  after?: ISODateTime;
  /** Maximum number of results. @default 50 */
  limit?: number;
}

/** Read/write interface for the notification center. */
export interface NotificationCenter {
  // ─── Notifications ───
  addNotification(notification: Notification): void;
  getNotification(id: string): Notification | undefined;
  getNotifications(filter?: NotificationFilter): Notification[];
  markAsRead(id: string): boolean;
  markAllAsRead(category?: NotificationCategory): number;
  dismissNotification(id: string): boolean;
  deleteNotification(id: string): boolean;
  clearAll(category?: NotificationCategory): number;

  // ─── Summary ───
  getSummary(): NotificationSummary;

  // ─── Preferences ───
  setPreference(pref: NotificationCategoryPreference): void;
  getPreference(category: NotificationCategory): NotificationCategoryPreference | undefined;
  getAllPreferences(): NotificationCategoryPreference[];
  shouldDeliver(category: NotificationCategory, priority: NotificationPriority): boolean;
}

// ─── Priority Ordering ───

const PRIORITY_RANK: Readonly<Record<NotificationPriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/** All notification categories. */
const ALL_CATEGORIES: readonly NotificationCategory[] = [
  "system", "workflow", "integration", "security", "billing", "social", "update",
];

/** Default maximum notifications returned. */
const DEFAULT_LIMIT = 50;

// ─── Factory ───

/** Create a notification center instance. */
export function createNotificationCenter(): NotificationCenter {
  const notifications = new Map<string, Notification>();
  const preferences = new Map<NotificationCategory, NotificationCategoryPreference>();

  function filteredNotifications(filter: NotificationFilter = {}): Notification[] {
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const result: Notification[] = [];

    for (const n of notifications.values()) {
      if (n.dismissed) continue;
      if (filter.category !== undefined && n.category !== filter.category) continue;
      if (filter.read !== undefined && n.read !== filter.read) continue;
      if (filter.priority !== undefined && n.priority !== filter.priority) continue;
      if (filter.after !== undefined && n.createdAt <= filter.after) continue;
      result.push(n);
    }

    // Sort by creation time descending (newest first), urgent first at same time
    result.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    });

    return result.slice(0, limit);
  }

  return {
    // ─── Notifications ───

    addNotification(notification) {
      notifications.set(notification.id, notification);
    },

    getNotification(id) {
      return notifications.get(id);
    },

    getNotifications(filter) {
      return filteredNotifications(filter);
    },

    markAsRead(id) {
      const n = notifications.get(id);
      if (!n || n.read) return false;
      n.read = true;
      n.readAt = new Date().toISOString();
      return true;
    },

    markAllAsRead(category) {
      let count = 0;
      const now = new Date().toISOString();
      for (const n of notifications.values()) {
        if (n.read || n.dismissed) continue;
        if (category !== undefined && n.category !== category) continue;
        n.read = true;
        n.readAt = now;
        count++;
      }
      return count;
    },

    dismissNotification(id) {
      const n = notifications.get(id);
      if (!n || n.dismissed) return false;
      n.dismissed = true;
      return true;
    },

    deleteNotification(id) {
      return notifications.delete(id);
    },

    clearAll(category) {
      let count = 0;
      for (const [id, n] of notifications) {
        if (category !== undefined && n.category !== category) continue;
        notifications.delete(id);
        count++;
      }
      return count;
    },

    // ─── Summary ───

    getSummary() {
      const byCategory = {} as Record<NotificationCategory, number>;
      for (const cat of ALL_CATEGORIES) {
        byCategory[cat] = 0;
      }

      let totalUnread = 0;
      let hasUrgent = false;

      for (const n of notifications.values()) {
        if (n.read || n.dismissed) continue;
        totalUnread++;
        byCategory[n.category]++;
        if (n.priority === "urgent") hasUrgent = true;
      }

      return { totalUnread, byCategory, hasUrgent };
    },

    // ─── Preferences ───

    setPreference(pref) {
      preferences.set(pref.category, pref);
    },

    getPreference(category) {
      return preferences.get(category);
    },

    getAllPreferences() {
      return [...preferences.values()];
    },

    shouldDeliver(category, priority) {
      const pref = preferences.get(category);
      // No preference = deliver everything
      if (!pref) return true;
      // Category disabled for in-app
      if (!pref.inApp) return false;
      // Check minimum priority
      return PRIORITY_RANK[priority] >= PRIORITY_RANK[pref.minPriority];
    },
  };
}
