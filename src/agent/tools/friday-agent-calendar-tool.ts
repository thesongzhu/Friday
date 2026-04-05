import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import type { FridayCalendarService } from "../../calendar/friday-calendar-service.js";

// ─── Types ───

export interface CreateFridayAgentCalendarToolOptions {
  calendarService: FridayCalendarService;
}

// ─── Factory ───

export function createFridayAgentCalendarTool(
  options: CreateFridayAgentCalendarToolOptions,
): FridayAgentToolDefinition {
  const { calendarService } = options;

  return {
    name: "calendar",
    description:
      "Manage calendar events. Operations: " +
      "'list_events' lists events in a date range, " +
      "'create_event' creates a new event, " +
      "'update_event' updates an existing event, " +
      "'delete_event' deletes an event, " +
      "'find_free_slots' finds available time slots. " +
      "Supports Google Calendar and CalDAV.",
    parameters: {
      properties: {
        operation: {
          type: "string",
          enum: ["list_events", "create_event", "update_event", "delete_event", "find_free_slots"],
          description: "The calendar operation to perform.",
        },
        startDate: {
          type: "string",
          description: "Start date in ISO 8601 format (for list_events).",
        },
        endDate: {
          type: "string",
          description: "End date in ISO 8601 format (for list_events).",
        },
        title: {
          type: "string",
          description: "Event title (for create/update).",
        },
        description: {
          type: "string",
          description: "Event description (for create/update).",
        },
        startTime: {
          type: "string",
          description: "Event start time in ISO 8601 (for create/update).",
        },
        endTime: {
          type: "string",
          description: "Event end time in ISO 8601 (for create/update).",
        },
        location: {
          type: "string",
          description: "Event location (for create/update).",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Attendee email addresses (for create/update).",
        },
        eventId: {
          type: "string",
          description: "Event ID (for update/delete).",
        },
        date: {
          type: "string",
          description: "Date to check for free slots (for find_free_slots).",
        },
        durationMinutes: {
          type: "number",
          description: "Desired meeting duration in minutes (for find_free_slots).",
        },
        limit: {
          type: "number",
          description: "Max events to return (default: 50).",
        },
      },
      required: ["operation"],
    },

    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const operation = readStringParam(args, "operation", { required: true });

      try {
        switch (operation) {
          case "list_events": {
            const startDate = readStringParam(args, "startDate", { required: true });
            const endDate = readStringParam(args, "endDate", { required: true });
            const limit = readNumberParam(args, "limit", { integer: true });
            const events = await calendarService.listEvents(
              { startDate, endDate, limit: limit ?? 50 },
              signal,
            );
            return jsonResult({ count: events.length, events });
          }

          case "create_event": {
            const title = readStringParam(args, "title", { required: true });
            const startTime = readStringParam(args, "startTime", { required: true });
            const endTime = readStringParam(args, "endTime", { required: true });
            const description = readStringParam(args, "description");
            const location = readStringParam(args, "location");
            const attendees = readStringArrayParam(args, "attendees");

            const event = await calendarService.createEvent(
              { title, startTime, endTime, description, location, attendees },
              signal,
            );
            return jsonResult({ created: true, event });
          }

          case "update_event": {
            const eventId = readStringParam(args, "eventId", { required: true });
            const title = readStringParam(args, "title");
            const startTime = readStringParam(args, "startTime");
            const endTime = readStringParam(args, "endTime");
            const description = readStringParam(args, "description");
            const location = readStringParam(args, "location");
            const attendees = readStringArrayParam(args, "attendees");

            const event = await calendarService.updateEvent(
              { eventId, title, startTime, endTime, description, location, attendees },
              signal,
            );
            return jsonResult({ updated: true, event });
          }

          case "delete_event": {
            const eventId = readStringParam(args, "eventId", { required: true });
            await calendarService.deleteEvent(eventId, signal);
            return jsonResult({ deleted: true, eventId });
          }

          case "find_free_slots": {
            const date = readStringParam(args, "date", { required: true });
            const durationMinutes = readNumberParam(args, "durationMinutes", { required: true, integer: true }) as number;
            const slots = await calendarService.findFreeSlots(
              { date, durationMinutes },
              signal,
            );
            return jsonResult({ date, durationMinutes, slots });
          }

          default:
            return errorResult(
              `Unknown operation "${operation}". Valid: list_events, create_event, update_event, delete_event, find_free_slots.`,
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("abort")) {
          return errorResult("Calendar operation aborted.");
        }
        return errorResult(`Calendar error: ${message}`);
      }
    },
  };
}
