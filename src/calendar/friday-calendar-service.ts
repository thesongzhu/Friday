import { FridayDomainError } from "#errors";

// ─── Types ───

export interface FridayCalendarEvent {
  id: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendees?: string[];
  isAllDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
}

export interface FridayCalendarCreateRequest {
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  attendees?: string[];
  isAllDay?: boolean;
}

export interface FridayCalendarUpdateRequest {
  eventId: string;
  title?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  attendees?: string[];
}

export interface FridayCalendarListRequest {
  startDate: string;
  endDate: string;
  limit?: number;
}

export interface FridayCalendarFreeSlotsRequest {
  date: string;
  durationMinutes: number;
}

export interface FridayCalendarFreeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export interface FridayCalendarService {
  listEvents(request: FridayCalendarListRequest, signal: AbortSignal): Promise<FridayCalendarEvent[]>;
  createEvent(request: FridayCalendarCreateRequest, signal: AbortSignal): Promise<FridayCalendarEvent>;
  updateEvent(request: FridayCalendarUpdateRequest, signal: AbortSignal): Promise<FridayCalendarEvent>;
  deleteEvent(eventId: string, signal: AbortSignal): Promise<void>;
  findFreeSlots(request: FridayCalendarFreeSlotsRequest, signal: AbortSignal): Promise<FridayCalendarFreeSlot[]>;
}

// ─── Provider types ───

export type FridayCalendarListFn = (
  request: FridayCalendarListRequest,
  signal: AbortSignal,
) => Promise<FridayCalendarEvent[]>;

export type FridayCalendarCreateFn = (
  request: FridayCalendarCreateRequest,
  signal: AbortSignal,
) => Promise<FridayCalendarEvent>;

export type FridayCalendarUpdateFn = (
  request: FridayCalendarUpdateRequest,
  signal: AbortSignal,
) => Promise<FridayCalendarEvent>;

export type FridayCalendarDeleteFn = (
  eventId: string,
  signal: AbortSignal,
) => Promise<void>;

export type FridayCalendarFreeSlotsFn = (
  request: FridayCalendarFreeSlotsRequest,
  signal: AbortSignal,
) => Promise<FridayCalendarFreeSlot[]>;

export interface FridayCalendarServiceOptions {
  listFn: FridayCalendarListFn;
  createFn: FridayCalendarCreateFn;
  updateFn: FridayCalendarUpdateFn;
  deleteFn: FridayCalendarDeleteFn;
  freeSlotsFn: FridayCalendarFreeSlotsFn;
}

// ─── Validation ───

export function validateDateString(dateStr: string, label: string): void {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid date format for ${label}: "${dateStr}". Use ISO 8601 format (e.g. 2024-01-15T09:00:00Z).`,
      { httpStatus: 400 },
    );
  }
}

// ─── Factory ───

export function createFridayCalendarService(
  options: FridayCalendarServiceOptions,
): FridayCalendarService {
  const { listFn, createFn, updateFn, deleteFn, freeSlotsFn } = options;

  return {
    async listEvents(request, signal) {
      validateDateString(request.startDate, "startDate");
      validateDateString(request.endDate, "endDate");
      return listFn(request, signal);
    },

    async createEvent(request, signal) {
      validateDateString(request.startTime, "startTime");
      validateDateString(request.endTime, "endTime");
      if (!request.title || request.title.trim().length === 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "Event title is required.", { httpStatus: 400 });
      }
      return createFn(request, signal);
    },

    async updateEvent(request, signal) {
      if (!request.eventId) {
        throw new FridayDomainError("VALIDATION_ERROR", "Event ID is required.", { httpStatus: 400 });
      }
      if (request.startTime) validateDateString(request.startTime, "startTime");
      if (request.endTime) validateDateString(request.endTime, "endTime");
      return updateFn(request, signal);
    },

    async deleteEvent(eventId, signal) {
      if (!eventId) {
        throw new FridayDomainError("VALIDATION_ERROR", "Event ID is required.", { httpStatus: 400 });
      }
      return deleteFn(eventId, signal);
    },

    async findFreeSlots(request, signal) {
      validateDateString(request.date, "date");
      if (request.durationMinutes <= 0) {
        throw new FridayDomainError("VALIDATION_ERROR", "Duration must be positive.", { httpStatus: 400 });
      }
      return freeSlotsFn(request, signal);
    },
  };
}
