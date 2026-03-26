import type {
  FridayAutoFixApprovalResponse,
  FridayAutoFixExecutionResponse,
  FridayAutoFixMetricsResponse,
  FridayAgentLoopPolicy,
  FridayAgentLoopExpertModeSummary,
  FridayAgentLoopRunControlResponse,
  FridayAgentLoopRunRecord,
  FridayAgentLoopRunStatus,
  FridayBeginnerIntentResolution,
  FridayBeginSystemRemotePasskeyAssertionRequest,
  FridayBeginSystemRemotePasskeyAssertionResponse,
  FridayBeginSystemRemotePasskeyRegistrationRequest,
  FridayBeginSystemRemotePasskeyRegistrationResponse,
  FridayContinueAssistantWizardRequest,
  FridayDiagnosisIncidentStatus,
  FridayCreateSystemRemoteSessionRequest,
  FridayCreateSystemRemoteSessionResponse,
  FridayDeleteSystemRemoteDeviceResponse,
  FridayDeleteSystemRemotePasskeyResponse,
  FridayDeleteSystemRemoteSessionResponse,
  FridayExecuteAssistantTemplateRequest,
  FridayExecuteSystemIntentRequest,
  FridayExecuteSystemIntentResponse,
  FridayFixPlanRecord,
  FridayGetAutoFixActionResponse,
  FridayGetAgentLoopPolicyResponse,
  FridayGetAgentLoopExpertModeResponse,
  FridayGetAgentLoopRunResponse,
  FridayGetExpertAgentLoopRunResponse,
  FridayGetDiagnosisIncidentResponse,
  FridayGetIncidentDiagnosisResponse,
  FridayGetSystemSessionResponse,
  FridayGetSystemStateResponse,
  FridayGuidedWizardState,
  FridayIssueCard,
  FridayGetWorkflowOverviewResponse,
  FridayGetWorkflowVisualizationResponse,
  FridayListAutoFixActionsResponse,
  FridayListAgentLoopRunsResponse,
  FridayListExpertAgentLoopRunsResponse,
  FridayListAcceptanceResultsResponse,
  FridayListAcceptanceTestsResponse,
  FridayListObservabilityAlertsResponse,
  FridayListObservabilityAlertDestinationsResponse,
  FridayListObservabilitySlosResponse,
  FridayListDiagnosisIncidentsResponse,
  FridayListRetryCircuitBreakersResponse,
  FridayListRetryEscalationsResponse,
  FridayListRulesAuditLogResponse,
  FridayListSystemApprovalsResponse,
  FridayListSystemEventsResponse,
  FridayListSystemRemoteDevicesResponse,
  FridayListSystemRemoteSessionsResponse,
  FridayObservabilityAlertSeverity,
  FridayObservabilityAlertStatus,
  FridayObservabilityAlertDestination,
  FridayObservabilityAlertSummary,
  FridayObservabilityBucketSize,
  FridayObservabilityModule,
  FridayObservabilityOverview,
  FridayObservabilitySloSummary,
  FridayObservabilityTimeSeriesResult,
  FridayRetryCircuitBreakerSummary,
  FridayRetryCostSummaryResponse,
  FridayRetryEscalationSummary,
  FridayRulesAuditLogEntry,
  FridayTestObservabilityAlertDispatchResponse,
  FridaySearchObservabilityAuditResponse,
  FridaySearchObservabilityTracesResponse,
  FridayUixTemplateExecutionResponse,
  FridayUixIssuesResponse,
  FridayUixTemplatesResponse,
  FridayUixWizardResponse,
  FridayRegisterSystemRemoteDeviceRequest,
  FridayDeployWorkflowDraftRequest,
  FridayDeployWorkflowDraftResponse,
  FridaySystemApprovalDecision,
  FridaySystemApprovalRule,
  FridaySystemEvent,
  FridaySystemIntentResult,
  FridaySystemRemoteDevice,
  FridaySystemRemoteSession,
  FridaySystemSession,
  FridaySystemSnapshot,
  FridayUpdateSystemApprovalRequest,
  FridayUpdateSystemApprovalResponse,
  FridayUpdateAgentLoopPolicyRequest,
  FridayUpdateAgentLoopPolicyResponse,
  FridayUpdateAgentLoopExpertModeRequest,
  FridayUpdateAgentLoopExpertModeResponse,
  FridayVerifySystemRemotePasskeyAssertionRequest,
  FridayVerifySystemRemotePasskeyAssertionResponse,
  FridayVerifySystemRemotePasskeyRegistrationRequest,
  FridayVerifySystemRemotePasskeyRegistrationResponse,
  FridayWorkflowDeployResult,
  FridayWorkflowOverview,
  FridayWorkflowVisualization,
  FridayGetObservabilityOverviewResponse,
  FridayGetObservabilityTimeSeriesResponse,
  FridayGetObservabilitySloResponse,
  FridayCreateObservabilityAlertDestinationRequest,
  FridayCommunicationPersona,
  FridayDeleteUserPreferenceResponse,
  FridayUpdateObservabilityAlertDestinationRequest,
  FridayGetCommunicationPersonaResponse,
  FridayListUserPreferencesResponse,
  FridayUpdateUserPreferencesRequest,
  FridayUpdateUserPreferencesResponse,
  FridayUserPreference,
} from "./system-types";

export interface FridayOperatorTransport {
  get<TResponse>(path: string, init?: RequestInit): Promise<TResponse>;
  post<TRequest, TResponse>(path: string, body: TRequest, init?: RequestInit): Promise<TResponse>;
  put<TRequest, TResponse>(path: string, body: TRequest, init?: RequestInit): Promise<TResponse>;
  patch<TRequest, TResponse>(path: string, body: TRequest, init?: RequestInit): Promise<TResponse>;
  del<TResponse>(path: string, init?: RequestInit): Promise<TResponse>;
}

export interface FridayOperatorClientOptions {
  transport: FridayOperatorTransport;
  createIdempotencyKey?: () => string;
}

function defaultIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `operator-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createFridayOperatorClient(options: FridayOperatorClientOptions) {
  const createIdempotencyKey = options.createIdempotencyKey ?? defaultIdempotencyKey;
  const transport = options.transport;

  return {
    async getSession(): Promise<FridaySystemSession> {
      const data = await transport.get<FridayGetSystemSessionResponse>("/v1/system/session");
      return data.session;
    },

    async getState(): Promise<FridaySystemSnapshot> {
      const data = await transport.get<FridayGetSystemStateResponse>("/v1/system/state");
      return data.snapshot;
    },

    async executeIntent(
      input: Omit<FridayExecuteSystemIntentRequest, "idempotencyKey">,
    ): Promise<FridaySystemIntentResult> {
      const data = await transport.post<
        FridayExecuteSystemIntentRequest,
        FridayExecuteSystemIntentResponse
      >("/v1/system/intents", {
        ...input,
        idempotencyKey: createIdempotencyKey(),
      });
      return data.result;
    },

    async listApprovals(query?: {
      action?: string;
      appIdentifier?: string;
      decision?: FridaySystemApprovalDecision;
      limit?: number;
      cursor?: string;
    }): Promise<FridayListSystemApprovalsResponse> {
      const params = new URLSearchParams();
      if (query?.action) params.set("action", query.action);
      if (query?.appIdentifier) params.set("appIdentifier", query.appIdentifier);
      if (query?.decision) params.set("decision", query.decision);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.cursor) params.set("cursor", query.cursor);
      const path = params.size > 0 ? `/v1/system/approvals?${params.toString()}` : "/v1/system/approvals";
      return transport.get<FridayListSystemApprovalsResponse>(path);
    },

    async updateApproval(
      approvalId: string,
      patch: Omit<FridayUpdateSystemApprovalRequest, "idempotencyKey">,
    ): Promise<FridaySystemApprovalRule> {
      const data = await transport.patch<
        FridayUpdateSystemApprovalRequest,
        FridayUpdateSystemApprovalResponse
      >(`/v1/system/approvals/${encodeURIComponent(approvalId)}`, {
        ...patch,
        idempotencyKey: createIdempotencyKey(),
      });
      return data.approval;
    },

    async listEvents(query?: {
      afterSeq?: number;
      limit?: number;
      stream?: false;
    }): Promise<FridaySystemEvent[]> {
      const params = new URLSearchParams();
      if (query?.afterSeq !== undefined) params.set("afterSeq", String(query.afterSeq));
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.stream === false) params.set("stream", "false");
      const path = params.size > 0 ? `/v1/system/events?${params.toString()}` : "/v1/system/events";
      const data = await transport.get<FridayListSystemEventsResponse>(path);
      return data.items;
    },

    async listRemoteDevices(): Promise<FridaySystemRemoteDevice[]> {
      const data = await transport.get<FridayListSystemRemoteDevicesResponse>("/v1/system/remote/devices");
      return data.items;
    },

    async listRemoteSessions(query?: {
      deviceId?: string;
      status?: "active" | "closed";
      limit?: number;
    }): Promise<FridaySystemRemoteSession[]> {
      const params = new URLSearchParams();
      if (query?.deviceId) params.set("deviceId", query.deviceId);
      if (query?.status) params.set("status", query.status);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/system/remote/sessions?${params.toString()}` : "/v1/system/remote/sessions";
      const data = await transport.get<FridayListSystemRemoteSessionsResponse>(path);
      return data.items;
    },

    async registerRemoteDevice(
      input: Omit<FridayRegisterSystemRemoteDeviceRequest, "idempotencyKey">,
    ): Promise<FridaySystemRemoteDevice> {
      const data = await transport.post<
        FridayRegisterSystemRemoteDeviceRequest,
        { device: FridaySystemRemoteDevice }
      >("/v1/system/remote/devices/register", {
        ...input,
        idempotencyKey: createIdempotencyKey(),
      });
      return data.device;
    },

    async revokeRemoteDevice(deviceId: string): Promise<FridayDeleteSystemRemoteDeviceResponse> {
      return transport.del<FridayDeleteSystemRemoteDeviceResponse>(
        `/v1/system/remote/devices/${encodeURIComponent(deviceId)}`,
      );
    },

    async clearRemoteDevicePasskey(deviceId: string): Promise<FridayDeleteSystemRemotePasskeyResponse> {
      return transport.del<FridayDeleteSystemRemotePasskeyResponse>(
        `/v1/system/remote/devices/${encodeURIComponent(deviceId)}/passkey`,
      );
    },

    async beginRemotePasskeyRegistration(
      deviceId: string,
    ): Promise<FridayBeginSystemRemotePasskeyRegistrationResponse> {
      return transport.post<
        FridayBeginSystemRemotePasskeyRegistrationRequest,
        FridayBeginSystemRemotePasskeyRegistrationResponse
      >("/v1/system/remote/auth/register/options", {
        deviceId,
        idempotencyKey: createIdempotencyKey(),
      });
    },

    async verifyRemotePasskeyRegistration(input: {
      deviceId: string;
      challengeId: string;
      response: FridayVerifySystemRemotePasskeyRegistrationRequest["response"];
    }): Promise<FridayVerifySystemRemotePasskeyRegistrationResponse> {
      return transport.post<
        FridayVerifySystemRemotePasskeyRegistrationRequest,
        FridayVerifySystemRemotePasskeyRegistrationResponse
      >("/v1/system/remote/auth/register/verify", {
        deviceId: input.deviceId,
        challengeId: input.challengeId,
        response: input.response,
        idempotencyKey: createIdempotencyKey(),
      });
    },

    async beginRemotePasskeyAssertion(
      deviceId: string,
    ): Promise<FridayBeginSystemRemotePasskeyAssertionResponse> {
      return transport.post<
        FridayBeginSystemRemotePasskeyAssertionRequest,
        FridayBeginSystemRemotePasskeyAssertionResponse
      >("/v1/system/remote/auth/assert/options", {
        deviceId,
        idempotencyKey: createIdempotencyKey(),
      });
    },

    async verifyRemotePasskeyAssertion(input: {
      deviceId: string;
      challengeId: string;
      response: FridayVerifySystemRemotePasskeyAssertionRequest["response"];
    }): Promise<FridayVerifySystemRemotePasskeyAssertionResponse> {
      return transport.post<
        FridayVerifySystemRemotePasskeyAssertionRequest,
        FridayVerifySystemRemotePasskeyAssertionResponse
      >("/v1/system/remote/auth/assert/verify", {
        deviceId: input.deviceId,
        challengeId: input.challengeId,
        response: input.response,
        idempotencyKey: createIdempotencyKey(),
      });
    },

    async openRemoteSession(input: {
      deviceId: string;
      assertionToken: string;
    }): Promise<FridayCreateSystemRemoteSessionResponse> {
      return transport.post<
        FridayCreateSystemRemoteSessionRequest,
        FridayCreateSystemRemoteSessionResponse
      >("/v1/system/remote/sessions", {
        deviceId: input.deviceId,
        assertionToken: input.assertionToken,
        idempotencyKey: createIdempotencyKey(),
      });
    },

    async closeRemoteSession(sessionId: string): Promise<FridayDeleteSystemRemoteSessionResponse> {
      return transport.del<FridayDeleteSystemRemoteSessionResponse>(
        `/v1/system/remote/sessions/${encodeURIComponent(sessionId)}`,
      );
    },

    async listDiagnosisIncidents(query?: {
      status?: FridayDiagnosisIncidentStatus;
      limit?: number;
    }): Promise<FridayListDiagnosisIncidentsResponse> {
      const params = new URLSearchParams();
      if (query?.status) params.set("status", query.status);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/diagnosis/incidents?${params.toString()}` : "/v1/diagnosis/incidents";
      return transport.get<FridayListDiagnosisIncidentsResponse>(path);
    },

    async getDiagnosisIncident(incidentId: string): Promise<FridayGetDiagnosisIncidentResponse> {
      return transport.get<FridayGetDiagnosisIncidentResponse>(
        `/v1/diagnosis/incidents/${encodeURIComponent(incidentId)}`,
      );
    },

    async getIncidentDiagnosis(incidentId: string): Promise<FridayGetIncidentDiagnosisResponse> {
      return transport.get<FridayGetIncidentDiagnosisResponse>(
        `/v1/diagnosis/incidents/${encodeURIComponent(incidentId)}/diagnosis`,
      );
    },

    async listAutoFixActions(query?: {
      status?: FridayFixPlanRecord["action"]["status"];
      incidentId?: string;
      limit?: number;
    }): Promise<FridayListAutoFixActionsResponse> {
      const params = new URLSearchParams();
      if (query?.status) params.set("status", query.status);
      if (query?.incidentId) params.set("incidentId", query.incidentId);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/auto-fix/actions?${params.toString()}` : "/v1/auto-fix/actions";
      return transport.get<FridayListAutoFixActionsResponse>(path);
    },

    async getAutoFixAction(actionId: string): Promise<FridayGetAutoFixActionResponse> {
      return transport.get<FridayGetAutoFixActionResponse>(
        `/v1/auto-fix/actions/${encodeURIComponent(actionId)}`,
      );
    },

    async approveAutoFixAction(actionId: string, reason?: string): Promise<FridayAutoFixApprovalResponse> {
      return transport.post<{ reason?: string }, FridayAutoFixApprovalResponse>(
        `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/approve`,
        reason ? { reason } : {},
      );
    },

    async denyAutoFixAction(actionId: string, reason?: string): Promise<FridayAutoFixApprovalResponse> {
      return transport.post<{ reason?: string }, FridayAutoFixApprovalResponse>(
        `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/deny`,
        reason ? { reason } : {},
      );
    },

    async executeAutoFixAction(actionId: string): Promise<FridayAutoFixExecutionResponse> {
      return transport.post<Record<string, never>, FridayAutoFixExecutionResponse>(
        `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/execute`,
        {},
      );
    },

    async rollbackAutoFixAction(
      actionId: string,
      reason: string,
    ): Promise<FridayAutoFixExecutionResponse> {
      return transport.post<{ reason: string }, FridayAutoFixExecutionResponse>(
        `/v1/auto-fix/actions/${encodeURIComponent(actionId)}/rollback`,
        { reason },
      );
    },

    async getAutoFixMetrics(query?: {
      day?: string;
      fromDay?: string;
      toDay?: string;
    }): Promise<FridayAutoFixMetricsResponse> {
      const params = new URLSearchParams();
      if (query?.day) params.set("day", query.day);
      if (query?.fromDay) params.set("fromDay", query.fromDay);
      if (query?.toDay) params.set("toDay", query.toDay);
      const path = params.size > 0 ? `/v1/auto-fix/metrics?${params.toString()}` : "/v1/auto-fix/metrics";
      return transport.get<FridayAutoFixMetricsResponse>(path);
    },

    async getAgentLoopPolicy(): Promise<FridayAgentLoopPolicy> {
      const data = await transport.get<FridayGetAgentLoopPolicyResponse>("/v1/agent-loop/policy");
      return data.policy;
    },

    async getAgentLoopExpertMode(): Promise<FridayAgentLoopExpertModeSummary> {
      const data = await transport.get<FridayGetAgentLoopExpertModeResponse>("/v1/agent-loop/expert-mode");
      return data.expertMode;
    },

    async updateAgentLoopPolicy(
      patch: FridayUpdateAgentLoopPolicyRequest,
    ): Promise<FridayAgentLoopPolicy> {
      const data = await transport.patch<
        FridayUpdateAgentLoopPolicyRequest,
        FridayUpdateAgentLoopPolicyResponse
      >("/v1/agent-loop/policy", patch);
      return data.policy;
    },

    async updateAgentLoopExpertMode(
      patch: FridayUpdateAgentLoopExpertModeRequest,
    ): Promise<FridayAgentLoopExpertModeSummary> {
      const data = await transport.patch<
        FridayUpdateAgentLoopExpertModeRequest,
        FridayUpdateAgentLoopExpertModeResponse
      >("/v1/agent-loop/expert-mode", patch);
      return data.expertMode;
    },

    async listAgentLoopRuns(query?: {
      status?: FridayAgentLoopRunStatus;
      limit?: number;
    }): Promise<FridayAgentLoopRunRecord[]> {
      const params = new URLSearchParams();
      if (query?.status) params.set("status", query.status);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/agent-loop/runs?${params.toString()}` : "/v1/agent-loop/runs";
      const data = await transport.get<FridayListAgentLoopRunsResponse>(path);
      return data.items;
    },

    async getAgentLoopRun(loopRunId: string): Promise<FridayAgentLoopRunRecord> {
      return transport.get<FridayGetAgentLoopRunResponse>(
        `/v1/agent-loop/runs/${encodeURIComponent(loopRunId)}`,
      );
    },

    async listExpertAgentLoopRuns(query?: {
      status?: FridayAgentLoopRunStatus;
      limit?: number;
    }): Promise<FridayAgentLoopRunRecord[]> {
      const params = new URLSearchParams();
      if (query?.status) params.set("status", query.status);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0
        ? `/v1/agent-loop/expert-runs?${params.toString()}`
        : "/v1/agent-loop/expert-runs";
      const data = await transport.get<FridayListExpertAgentLoopRunsResponse>(path);
      return data.items;
    },

    async getExpertAgentLoopRun(loopRunId: string): Promise<FridayAgentLoopRunRecord> {
      return transport.get<FridayGetExpertAgentLoopRunResponse>(
        `/v1/agent-loop/expert-runs/${encodeURIComponent(loopRunId)}`,
      );
    },

    async pauseAgentLoopRun(loopRunId: string): Promise<FridayAgentLoopRunRecord> {
      const data = await transport.post<Record<string, never>, FridayAgentLoopRunControlResponse>(
        `/v1/agent-loop/runs/${encodeURIComponent(loopRunId)}/pause`,
        {},
      );
      return data.run;
    },

    async resumeAgentLoopRun(loopRunId: string): Promise<FridayAgentLoopRunRecord> {
      const data = await transport.post<Record<string, never>, FridayAgentLoopRunControlResponse>(
        `/v1/agent-loop/runs/${encodeURIComponent(loopRunId)}/resume`,
        {},
      );
      return data.run;
    },

    async cancelAgentLoopRun(loopRunId: string): Promise<FridayAgentLoopRunRecord> {
      const data = await transport.post<Record<string, never>, FridayAgentLoopRunControlResponse>(
        `/v1/agent-loop/runs/${encodeURIComponent(loopRunId)}/cancel`,
        {},
      );
      return data.run;
    },

    async resolveAssistantIntent(text: string): Promise<FridayBeginnerIntentResolution> {
      return transport.post<{ text: string }, FridayBeginnerIntentResolution>(
        "/v1/uix/intents/resolve",
        { text },
      );
    },

    async listAssistantTemplates(): Promise<FridayUixTemplatesResponse> {
      return transport.get<FridayUixTemplatesResponse>("/v1/uix/templates");
    },

    async executeAssistantTemplate(
      input: FridayExecuteAssistantTemplateRequest,
    ): Promise<FridayUixTemplateExecutionResponse> {
      return transport.post<{
        parameters?: Record<string, unknown>;
        assistantSessionKey?: string;
      }, FridayUixTemplateExecutionResponse>(
        `/v1/uix/templates/${encodeURIComponent(input.templateId)}/execute`,
        {
          parameters: input.parameters ?? {},
          assistantSessionKey: input.assistantSessionKey,
        },
      );
    },

    async startAssistantWizard(
      wizardId: string,
      assistantSessionKey?: string,
    ): Promise<FridayGuidedWizardState> {
      const data = await transport.post<{ assistantSessionKey?: string }, FridayUixWizardResponse>(
        `/v1/uix/wizards/${encodeURIComponent(wizardId)}/start`,
        { assistantSessionKey },
      );
      return data.wizard;
    },

    async continueAssistantWizard(
      input: FridayContinueAssistantWizardRequest,
    ): Promise<FridayUixWizardResponse> {
      return transport.post<
        {
          contextId: string;
          values?: Record<string, unknown>;
          assistantSessionKey?: string;
        },
        FridayUixWizardResponse
      >(`/v1/uix/wizards/${encodeURIComponent(input.wizardId)}/continue`, {
        contextId: input.contextId,
        values: input.values ?? {},
        assistantSessionKey: input.assistantSessionKey,
      });
    },

    async listAssistantIssues(limit?: number): Promise<FridayIssueCard[]> {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      const path = params.size > 0 ? `/v1/uix/issues?${params.toString()}` : "/v1/uix/issues";
      const data = await transport.get<FridayUixIssuesResponse>(path);
      return data.items;
    },

    async listCommunicationPreferences(): Promise<FridayUserPreference[]> {
      const data = await transport.get<FridayListUserPreferencesResponse>("/v1/uix/preferences?category=communication");
      return data.items;
    },

    async updateCommunicationPreferences(
      preferences: FridayUpdateUserPreferencesRequest["preferences"],
    ): Promise<FridayUpdateUserPreferencesResponse> {
      return transport.put<FridayUpdateUserPreferencesRequest, FridayUpdateUserPreferencesResponse>(
        "/v1/uix/preferences",
        { preferences },
      );
    },

    async deleteCommunicationPreference(preferenceId: string): Promise<FridayDeleteUserPreferenceResponse> {
      return transport.del<FridayDeleteUserPreferenceResponse>(
        `/v1/uix/preferences/${encodeURIComponent(preferenceId)}`,
      );
    },

    async getCommunicationPersona(): Promise<FridayCommunicationPersona> {
      const data = await transport.get<FridayGetCommunicationPersonaResponse>("/v1/uix/persona");
      return data.persona;
    },

    async getWorkflowOverview(
      workflowId: string,
      query?: { recentRunLimit?: number },
    ): Promise<FridayWorkflowOverview> {
      const params = new URLSearchParams();
      if (query?.recentRunLimit !== undefined) {
        params.set("recentRunLimit", String(query.recentRunLimit));
      }
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const data = await transport.get<FridayGetWorkflowOverviewResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/overview${suffix}`,
      );
      return data.overview;
    },

    async getWorkflowVisualization(
      workflowId: string,
      query?: {
        draftId?: string;
        versionId?: string;
        timelineLimit?: number;
      },
    ): Promise<FridayWorkflowVisualization> {
      const params = new URLSearchParams();
      if (query?.draftId) params.set("draftId", query.draftId);
      if (query?.versionId) params.set("versionId", query.versionId);
      if (query?.timelineLimit !== undefined) params.set("timelineLimit", String(query.timelineLimit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const data = await transport.get<FridayGetWorkflowVisualizationResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/visualization${suffix}`,
      );
      return data.visualization;
    },

    async deployWorkflowDraft(
      workflowId: string,
      draftId: string,
      input: FridayDeployWorkflowDraftRequest,
    ): Promise<FridayWorkflowDeployResult> {
      const data = await transport.post<FridayDeployWorkflowDraftRequest, FridayDeployWorkflowDraftResponse>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/drafts/${encodeURIComponent(draftId)}/deploy`,
        input,
      );
      return data.deployment;
    },

    async listAcceptanceTests(query?: {
      artifactType?: string;
      enabled?: boolean;
      limit?: number;
    }) {
      const params = new URLSearchParams();
      if (query?.artifactType) params.set("artifactType", query.artifactType);
      if (query?.enabled !== undefined) params.set("enabled", String(query.enabled));
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const data = await transport.get<FridayListAcceptanceTestsResponse>(`/v1/acceptance/tests${suffix}`);
      return data.items;
    },

    async listAcceptanceResults(query?: {
      overallVerdict?: string;
      limit?: number;
    }) {
      const params = new URLSearchParams();
      if (query?.overallVerdict) params.set("overallVerdict", query.overallVerdict);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const data = await transport.get<FridayListAcceptanceResultsResponse>(`/v1/acceptance/results${suffix}`);
      return data.items;
    },

    async listRetryEscalations(query?: {
      acknowledged?: boolean;
      limit?: number;
    }): Promise<FridayRetryEscalationSummary[]> {
      const params = new URLSearchParams();
      if (query?.acknowledged !== undefined) params.set("acknowledged", String(query.acknowledged));
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const data = await transport.get<FridayListRetryEscalationsResponse>(`/v1/retry/escalations${suffix}`);
      return data.items;
    },

    async listRetryCircuitBreakers(): Promise<FridayRetryCircuitBreakerSummary[]> {
      const data = await transport.get<FridayListRetryCircuitBreakersResponse>("/v1/retry/circuit-breakers");
      return data.items;
    },

    async getRetryCostSummary(query?: {
      runId?: string;
      workflowId?: string;
      nodeId?: string;
      policyId?: string;
    }) {
      const params = new URLSearchParams();
      if (query?.runId) params.set("runId", query.runId);
      if (query?.workflowId) params.set("workflowId", query.workflowId);
      if (query?.nodeId) params.set("nodeId", query.nodeId);
      if (query?.policyId) params.set("policyId", query.policyId);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      return transport.get<FridayRetryCostSummaryResponse>(`/v1/retry/costs${suffix}`);
    },

    async listRulesAuditLog(query?: {
      runId?: string;
      decision?: string;
      limit?: number;
    }): Promise<FridayRulesAuditLogEntry[]> {
      const params = new URLSearchParams();
      if (query?.runId) params.set("runId", query.runId);
      if (query?.decision) params.set("decision", query.decision);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const data = await transport.get<FridayListRulesAuditLogResponse>(`/v1/rules/audit-log${suffix}`);
      return data.items;
    },

    async getObservabilityOverview(): Promise<FridayObservabilityOverview> {
      const data = await transport.get<FridayGetObservabilityOverviewResponse>("/v1/observability/overview");
      return data.overview;
    },

    async getObservabilityTimeSeries(input: {
      metricName: string;
      startTime: string;
      endTime: string;
      bucketSize?: FridayObservabilityBucketSize;
    }): Promise<FridayObservabilityTimeSeriesResult> {
      const params = new URLSearchParams({
        metricName: input.metricName,
        startTime: input.startTime,
        endTime: input.endTime,
      });
      if (input.bucketSize) {
        params.set("bucketSize", input.bucketSize);
      }
      const data = await transport.get<FridayGetObservabilityTimeSeriesResponse>(
        `/v1/observability/time-series?${params.toString()}`,
      );
      return data.series;
    },

    async searchObservabilityTraces(query?: {
      module?: FridayObservabilityModule;
      status?: "unset" | "ok" | "error";
      limit?: number;
    }): Promise<FridaySearchObservabilityTracesResponse> {
      const params = new URLSearchParams();
      if (query?.module) params.set("module", query.module);
      if (query?.status) params.set("status", query.status);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/observability/traces?${params.toString()}` : "/v1/observability/traces";
      return transport.get<FridaySearchObservabilityTracesResponse>(path);
    },

    async searchObservabilityAudit(query?: {
      module?: FridayObservabilityModule;
      outcome?: "success" | "failure" | "denied" | "error";
      limit?: number;
    }): Promise<FridaySearchObservabilityAuditResponse> {
      const params = new URLSearchParams();
      if (query?.module) params.set("module", query.module);
      if (query?.outcome) params.set("outcome", query.outcome);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/observability/audit?${params.toString()}` : "/v1/observability/audit";
      return transport.get<FridaySearchObservabilityAuditResponse>(path);
    },

    async listObservabilityAlerts(query?: {
      module?: FridayObservabilityModule;
      severity?: FridayObservabilityAlertSeverity;
      status?: FridayObservabilityAlertStatus;
      limit?: number;
    }): Promise<FridayListObservabilityAlertsResponse> {
      const params = new URLSearchParams();
      if (query?.module) params.set("module", query.module);
      if (query?.severity) params.set("severity", query.severity);
      if (query?.status) params.set("status", query.status);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/observability/alerts?${params.toString()}` : "/v1/observability/alerts";
      return transport.get<FridayListObservabilityAlertsResponse>(path);
    },

    async acknowledgeObservabilityAlert(alertId: string, note?: string) {
      return transport.post<{ note?: string }, { alert: FridayObservabilityAlertSummary }>(
        `/v1/observability/alerts/${encodeURIComponent(alertId)}/acknowledge`,
        note ? { note } : {},
      );
    },

    async listObservabilitySlos(query?: {
      status?: "healthy" | "warning" | "breached";
      enabled?: boolean;
      module?: FridayObservabilityModule;
      tag?: string;
      limit?: number;
    }): Promise<FridayObservabilitySloSummary[]> {
      const params = new URLSearchParams();
      if (query?.status) params.set("status", query.status);
      if (query?.enabled !== undefined) params.set("enabled", String(query.enabled));
      if (query?.module) params.set("module", query.module);
      if (query?.tag) params.set("tag", query.tag);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const path = params.size > 0 ? `/v1/observability/slos?${params.toString()}` : "/v1/observability/slos";
      const data = await transport.get<FridayListObservabilitySlosResponse>(path);
      return data.items;
    },

    async getObservabilitySlo(sloId: string) {
      return transport.get<FridayGetObservabilitySloResponse>(
        `/v1/observability/slos/${encodeURIComponent(sloId)}`,
      );
    },

    async listObservabilityAlertDestinations(): Promise<FridayObservabilityAlertDestination[]> {
      const data = await transport.get<FridayListObservabilityAlertDestinationsResponse>(
        "/v1/observability/alert-destinations",
      );
      return data.items;
    },

    async createObservabilityAlertDestination(input: FridayCreateObservabilityAlertDestinationRequest) {
      const data = await transport.post<
        FridayCreateObservabilityAlertDestinationRequest,
        { destination: FridayObservabilityAlertDestination }
      >("/v1/observability/alert-destinations", input);
      return data.destination;
    },

    async updateObservabilityAlertDestination(
      destinationId: string,
      input: FridayUpdateObservabilityAlertDestinationRequest,
    ) {
      const data = await transport.patch<
        FridayUpdateObservabilityAlertDestinationRequest,
        { destination: FridayObservabilityAlertDestination }
      >(`/v1/observability/alert-destinations/${encodeURIComponent(destinationId)}`, input);
      return data.destination;
    },

    async deleteObservabilityAlertDestination(destinationId: string) {
      return transport.del<{ deleted: true; destinationId: string }>(
        `/v1/observability/alert-destinations/${encodeURIComponent(destinationId)}`,
      );
    },

    async testObservabilityAlertDispatch(alertId: string, destinationId?: string) {
      return transport.post<{ destinationId?: string }, FridayTestObservabilityAlertDispatchResponse>(
        `/v1/observability/alerts/${encodeURIComponent(alertId)}/test-dispatch`,
        destinationId ? { destinationId } : {},
      );
    },
  };
}

export type FridayOperatorClient = ReturnType<typeof createFridayOperatorClient>;
