import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ActionButton, ShellCard, StatusPill } from "@/components/core/primitives";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import {
  taskWorkflowsApi,
  type TaskWorkflowEvidenceExplorerEntry,
  type TaskWorkflowEvidenceRawDrilldown,
  type TaskWorkflowListItem,
  type TaskWorkflowSupervisorOverview,
} from "@/lib/api/task-workflows";

function toneForClaimStatus(
  status: "draft" | "unverified" | "verified" | "blocked",
): "neutral" | "success" | "warning" | "danger" {
  if (status === "verified") return "success";
  if (status === "unverified" || status === "draft") return "warning";
  if (status === "blocked") return "danger";
  return "neutral";
}

function toneForGateStatus(
  status: "pass" | "block" | "not_applicable",
): "neutral" | "success" | "warning" | "danger" {
  if (status === "pass") return "success";
  if (status === "block") return "danger";
  return "neutral";
}

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

interface SupervisorPanelProps {
  overview: TaskWorkflowSupervisorOverview;
}

function ContextPackageCard({ overview }: SupervisorPanelProps) {
  const { locale } = useAppLocale();
  const summary = overview.contextPackageSummary;
  return (
    <ShellCard title={localize(locale, "上下文包摘要", "Context package summary")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "仅展示边界与基数信息。整库内容默认不暴露。",
          "Cardinality and boundary refs only. Whole-repo content is never exposed by default.",
        )}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "12px" }}>
        <div>
          <div style={{ fontSize: "12px", color: "#666" }}>
            {localize(locale, "允许文件数", "Allowed files")}
          </div>
          <div style={{ fontSize: "20px", fontWeight: 600 }}>{summary.allowedFilesCount}</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "#666" }}>
            {localize(locale, "允许工具数", "Allowed tools")}
          </div>
          <div style={{ fontSize: "20px", fontWeight: 600 }}>{summary.allowedToolsCount}</div>
        </div>
        <div>
          <div style={{ fontSize: "12px", color: "#666" }}>
            {localize(locale, "允许 API 数", "Allowed APIs")}
          </div>
          <div style={{ fontSize: "20px", fontWeight: 600 }}>{summary.allowedApisCount}</div>
        </div>
      </div>
      <div style={{ marginTop: "12px" }}>
        <div style={{ fontSize: "12px", color: "#666" }}>
          {localize(locale, "边界引用", "Boundary refs")}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "4px" }}>
          {overview.boundaryRefs.map((ref) => (
            <StatusPill key={ref} tone="neutral">
              {ref}
            </StatusPill>
          ))}
          {overview.boundaryRefs.length === 0 ? <span style={{ color: "#999" }}>—</span> : null}
        </div>
      </div>
    </ShellCard>
  );
}

function GatePlanCard({ overview }: SupervisorPanelProps) {
  const { locale } = useAppLocale();
  return (
    <ShellCard title={localize(locale, "门禁计划", "Gate plan")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "必选确定性门禁不能被模式或用户配置关闭。",
          "Required deterministic gates cannot be disabled by mode or user configuration.",
        )}
      </p>
      <table style={{ width: "100%", fontSize: "13px", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "4px" }}>Gate</th>
            <th style={{ textAlign: "left", padding: "4px" }}>
              {localize(locale, "必选", "Required")}
            </th>
            <th style={{ textAlign: "left", padding: "4px" }}>
              {localize(locale, "来源", "Source")}
            </th>
          </tr>
        </thead>
        <tbody>
          {overview.gatePlan.map((entry) => {
            const immutable = overview.immutableRequiredGateIds.includes(entry.gateId);
            return (
              <tr key={entry.gateId}>
                <td style={{ padding: "4px", fontFamily: "monospace" }}>{entry.gateId}</td>
                <td style={{ padding: "4px" }}>
                  {immutable || entry.required ? (
                    <StatusPill tone="danger">
                      {localize(locale, "不可关闭", "Immutable")}
                    </StatusPill>
                  ) : (
                    <StatusPill tone="neutral">
                      {localize(locale, "可选", "Optional")}
                    </StatusPill>
                  )}
                </td>
                <td style={{ padding: "4px" }}>
                  {entry.additiveUser
                    ? localize(locale, "用户附加", "User additive")
                    : localize(locale, "注册表必选", "Registry")}
                </td>
              </tr>
            );
          })}
          {overview.gatePlan.length === 0 ? (
            <tr>
              <td colSpan={3} style={{ padding: "8px", color: "#999" }}>
                {localize(locale, "未规划门禁", "No gates planned")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </ShellCard>
  );
}

function ClaimMatrixCard({ overview }: SupervisorPanelProps) {
  const { locale } = useAppLocale();
  const counts = overview.claimMatrix.counts;
  return (
    <ShellCard title={localize(locale, "声明矩阵", "Claim matrix")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "Verified 必须有证据引用 + 验证员裁定。",
          "Verified status requires evidence refs + verifier verdict.",
        )}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "12px" }}>
        <div>
          <StatusPill tone="warning">Draft</StatusPill>
          <div style={{ fontSize: "20px", fontWeight: 600 }}>{counts.draft}</div>
        </div>
        <div>
          <StatusPill tone="warning">Unverified</StatusPill>
          <div style={{ fontSize: "20px", fontWeight: 600 }}>{counts.unverified}</div>
        </div>
        <div>
          <StatusPill tone="success">Verified</StatusPill>
          <div style={{ fontSize: "20px", fontWeight: 600 }}>{counts.verified}</div>
        </div>
        <div>
          <StatusPill tone="danger">Blocked</StatusPill>
          <div style={{ fontSize: "20px", fontWeight: 600 }}>{counts.blocked}</div>
        </div>
      </div>
      {overview.claimMatrix.unverifiedClaims.length > 0 ? (
        <div style={{ marginTop: "12px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600 }}>
            {localize(locale, "待验证声明", "Unverified claims")}
          </div>
          <ul>
            {overview.claimMatrix.unverifiedClaims.map((claim) => (
              <li key={claim.id} style={{ fontSize: "13px" }}>
                <StatusPill tone={toneForClaimStatus(claim.status)}>{claim.status}</StatusPill>{" "}
                <code>{claim.claimKind}</code> — {claim.claimText}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {overview.claimMatrix.blockedClaims.length > 0 ? (
        <div style={{ marginTop: "12px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600 }}>
            {localize(locale, "已阻塞声明", "Blocked claims")}
          </div>
          <ul>
            {overview.claimMatrix.blockedClaims.map((claim) => (
              <li key={claim.id} style={{ fontSize: "13px" }}>
                <StatusPill tone="danger">blocked</StatusPill> {claim.claimText}{" "}
                {claim.reason ? <em>({claim.reason})</em> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ShellCard>
  );
}

function BlockersCard({ overview }: SupervisorPanelProps) {
  const { locale } = useAppLocale();
  return (
    <ShellCard title={localize(locale, "阻塞与游标", "Blockers & cursor")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "聚合监督员游标、声明、车道与门禁阻塞。",
          "Aggregated supervisor cursor, claim, lane, and gate blockers.",
        )}
      </p>
      <div style={{ fontSize: "13px", marginBottom: "8px" }}>
        {localize(locale, "当前阶段", "Current stage")}:{" "}
        <code>{overview.supervisorCursor?.currentStage ?? overview.workflow.stage}</code>
      </div>
      {overview.blockers.length === 0 ? (
        <div style={{ color: "#999" }}>
          {localize(locale, "暂无阻塞。", "No blockers.")}
        </div>
      ) : (
        <ul>
          {overview.blockers.map((blocker, idx) => (
            <li key={`${idx}-${blocker}`} style={{ fontSize: "13px" }}>
              <StatusPill tone="warning">!</StatusPill> {blocker}
            </li>
          ))}
        </ul>
      )}
    </ShellCard>
  );
}

function LaneSummaryCard({ overview }: SupervisorPanelProps) {
  const { locale } = useAppLocale();
  const exec = overview.laneSummary.executor;
  const ver = overview.laneSummary.verifier;
  return (
    <ShellCard title={localize(locale, "执行/验证车道摘要", "Executor / Verifier lane summary")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "Provider fallback 仅记录可用性,不替代独立验证。",
          "Provider fallback records availability only; never substitutes for independent verification.",
        )}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", fontSize: "13px" }}>
        <div>
          <div style={{ fontWeight: 600 }}>
            {localize(locale, "执行车道", "Executor")}
          </div>
          <div>{localize(locale, "总数", "Total")}: {exec.count}</div>
          <div>{localize(locale, "已完成", "Completed")}: {exec.completed}</div>
          <div>{localize(locale, "进行中", "Open")}: {exec.open}</div>
          <div>{localize(locale, "已阻塞", "Blocked")}: {exec.blocked}</div>
        </div>
        <div>
          <div style={{ fontWeight: 600 }}>
            {localize(locale, "验证车道", "Verifier")}
          </div>
          <div>{localize(locale, "总数", "Total")}: {ver.count}</div>
          <div>{localize(locale, "已完成", "Completed")}: {ver.completed}</div>
          <div>{localize(locale, "进行中", "Open")}: {ver.open}</div>
          <div>{localize(locale, "已阻塞", "Blocked")}: {ver.blocked}</div>
          <div>
            {localize(locale, "独立", "Independent")}: {ver.independent} ·{" "}
            {localize(locale, "降级", "Degraded")}: {ver.degraded}
          </div>
        </div>
      </div>
    </ShellCard>
  );
}

function ChannelCommandSummaryCard({ overview }: SupervisorPanelProps) {
  const { locale } = useAppLocale();
  const s = overview.channelCommandSummary;
  return (
    <ShellCard title={localize(locale, "渠道命令摘要", "Channel command summary")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "仅记录哈希身份与命令意图,不持久化原始消息文本。",
          "Hashed identities and canonical intents only; raw channel text is never persisted.",
        )}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: "8px", fontSize: "13px" }}>
        <div><StatusPill tone="neutral">Total</StatusPill><div>{s.total}</div></div>
        <div><StatusPill tone="warning">Issued</StatusPill><div>{s.issued}</div></div>
        <div><StatusPill tone="success">Dispatched</StatusPill><div>{s.dispatched}</div></div>
        <div><StatusPill tone="danger">Declined</StatusPill><div>{s.declined}</div></div>
        <div><StatusPill tone="neutral">Expired</StatusPill><div>{s.expired}</div></div>
      </div>
    </ShellCard>
  );
}

function CloseoutReceiptCard({ overview }: SupervisorPanelProps) {
  const { locale } = useAppLocale();
  const receipt = overview.closeoutReceipt;
  if (!receipt) {
    return (
      <ShellCard title={localize(locale, "结算回执", "Closeout receipt")}>
        <div style={{ color: "#999", fontSize: "13px" }}>
          {localize(locale, "尚未结算。", "Not yet closed out.")}
        </div>
      </ShellCard>
    );
  }
  return (
    <ShellCard title={localize(locale, "结算回执", "Closeout receipt")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "声明矩阵 + 门禁裁定快照",
          "Claim-matrix and gate-outcome snapshot",
        )}
      </p>
      <div style={{ marginBottom: "8px" }}>
        <StatusPill
          tone={
            receipt.status === "complete"
              ? "success"
              : receipt.status === "blocked"
                ? "danger"
                : "warning"
          }
        >
          {receipt.status}
        </StatusPill>{" "}
        <small style={{ color: "#666" }}>
          {formatTimestamp(receipt.createdAt)} · spec {receipt.specHash.slice(0, 12)}…
        </small>
      </div>
      <table style={{ width: "100%", fontSize: "13px", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "4px" }}>Gate</th>
            <th style={{ textAlign: "left", padding: "4px" }}>Status</th>
            <th style={{ textAlign: "left", padding: "4px" }}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {receipt.gateOutcomes.map((outcome) => (
            <tr key={outcome.gateId}>
              <td style={{ padding: "4px", fontFamily: "monospace" }}>{outcome.gateId}</td>
              <td style={{ padding: "4px" }}>
                <StatusPill tone={toneForGateStatus(outcome.status)}>{outcome.status}</StatusPill>
              </td>
              <td style={{ padding: "4px" }}>{outcome.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ShellCard>
  );
}

function EvidenceExplorerCard() {
  const { locale } = useAppLocale();
  const [workflowFilter, setWorkflowFilter] = useState<string>("");
  const evidenceQuery = useQuery({
    queryKey: ["task-workflow-evidence", workflowFilter],
    queryFn: () =>
      taskWorkflowsApi.queryEvidence({
        workflowId: workflowFilter.trim().length > 0 ? workflowFilter.trim() : undefined,
        limit: 100,
      }),
  });
  const [selectedRefId, setSelectedRefId] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<TaskWorkflowEvidenceRawDrilldown | null>(null);
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const openDrilldown = async (entry: TaskWorkflowEvidenceExplorerEntry) => {
    const confirmed = window.confirm(
      localize(
        locale,
        "原始证据可能包含敏感字段。Friday 服务端会在返回前应用密钥模式脱敏。是否继续?",
        "Raw evidence may contain sensitive fields. Friday redacts secret patterns server-side before returning. Proceed?",
      ),
    );
    if (!confirmed) return;
    try {
      setDrilldownLoading(true);
      setSelectedRefId(entry.evidenceRefId);
      const result = await taskWorkflowsApi.getEvidenceRawDrilldown(entry.evidenceRefId);
      setDrilldown(result);
    } catch (error) {
      toast.error(
        localize(locale, "原始证据钻取失败", "Failed to open raw evidence drilldown"),
      );
      setDrilldown(null);
    } finally {
      setDrilldownLoading(false);
    }
  };

  return (
    <ShellCard title={localize(locale, "全局证据浏览器 (v1)", "Global Evidence Explorer (v1)")}>
      <p style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
        {localize(
          locale,
          "证据引用元数据索引;原始内容需显式门禁确认。",
          "Metadata index over existing evidence refs. Raw drilldown requires explicit gate confirmation.",
        )}
      </p>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" }}>
        <input
          value={workflowFilter}
          onChange={(e) => setWorkflowFilter(e.target.value)}
          placeholder={localize(locale, "按 workflowId 过滤", "Filter by workflowId")}
          style={{ flex: 1, padding: "4px 8px", fontSize: "13px" }}
        />
        <ActionButton onClick={() => evidenceQuery.refetch()}>
          {localize(locale, "刷新", "Refresh")}
        </ActionButton>
      </div>
      <table style={{ width: "100%", fontSize: "13px", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "4px" }}>Ref</th>
            <th style={{ textAlign: "left", padding: "4px" }}>Source</th>
            <th style={{ textAlign: "left", padding: "4px" }}>Claim</th>
            <th style={{ textAlign: "left", padding: "4px" }}>Hash</th>
            <th style={{ textAlign: "left", padding: "4px" }}></th>
          </tr>
        </thead>
        <tbody>
          {(evidenceQuery.data ?? []).map((entry) => (
            <tr key={entry.evidenceRefId}>
              <td style={{ padding: "4px", fontFamily: "monospace" }}>{entry.refKind}</td>
              <td style={{ padding: "4px" }}>{entry.refSource}</td>
              <td style={{ padding: "4px" }}>
                {entry.claimKind} · <StatusPill tone={toneForClaimStatus(entry.claimStatus)}>{entry.claimStatus}</StatusPill>
              </td>
              <td style={{ padding: "4px", fontFamily: "monospace" }}>
                {entry.refHash ? entry.refHash.slice(0, 12) + "…" : "—"}
              </td>
              <td style={{ padding: "4px" }}>
                <ActionButton onClick={() => openDrilldown(entry)}>
                  {localize(locale, "钻取原始", "Raw")}
                </ActionButton>
              </td>
            </tr>
          ))}
          {(evidenceQuery.data ?? []).length === 0 ? (
            <tr>
              <td colSpan={5} style={{ padding: "8px", color: "#999" }}>
                {localize(locale, "暂无证据引用。", "No evidence refs indexed.")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {selectedRefId ? (
        <div style={{ marginTop: "12px", padding: "12px", border: "1px solid #ccc", fontSize: "13px" }}>
          <div style={{ fontWeight: 600 }}>
            {localize(locale, "原始证据(已脱敏)", "Raw evidence (redacted)")}
          </div>
          {drilldownLoading ? <div>{localize(locale, "加载中...", "Loading...")}</div> : null}
          {drilldown ? (
            <div>
              <div>refId: <code>{drilldown.refIdRedacted}</code></div>
              <div>
                {localize(locale, "脱敏应用", "Redaction applied")}:{" "}
                <StatusPill tone={drilldown.redactionApplied ? "warning" : "success"}>
                  {drilldown.redactionApplied ? "yes" : "no"}
                </StatusPill>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </ShellCard>
  );
}

interface WorkflowSelectorProps {
  workflows: readonly TaskWorkflowListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function WorkflowSelector({ workflows, selectedId, onSelect }: WorkflowSelectorProps) {
  const { locale } = useAppLocale();
  if (workflows.length === 0) {
    return (
      <div style={{ color: "#999", fontSize: "13px" }}>
        {localize(locale, "暂无任务工作流。", "No task workflows yet.")}
      </div>
    );
  }
  return (
    <select
      value={selectedId ?? ""}
      onChange={(e) => onSelect(e.target.value)}
      style={{ padding: "4px 8px", fontSize: "13px" }}
    >
      <option value="" disabled>
        {localize(locale, "选择工作流", "Select workflow")}
      </option>
      {workflows.map((wf) => (
        <option key={wf.id} value={wf.id}>
          {wf.id.slice(0, 8)} · {wf.charter.slice(0, 40)}
        </option>
      ))}
    </select>
  );
}

export function TaskWorkflowsPage() {
  const { locale } = useAppLocale();
  const listQuery = useQuery({
    queryKey: ["task-workflows", "list"],
    queryFn: () => taskWorkflowsApi.list(),
  });
  const workflows = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveSelectedId = selectedId ?? workflows[0]?.id ?? null;
  const overviewQuery = useQuery({
    queryKey: ["task-workflows", "supervisor", effectiveSelectedId],
    queryFn: () =>
      effectiveSelectedId
        ? taskWorkflowsApi.getSupervisorOverview(effectiveSelectedId)
        : Promise.resolve(null),
    enabled: effectiveSelectedId !== null,
  });

  return (
    <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <h1 style={{ margin: 0, fontSize: "20px" }}>
          {localize(locale, "任务工作流", "Task Workflows")}
        </h1>
        <WorkflowSelector
          workflows={workflows}
          selectedId={effectiveSelectedId}
          onSelect={setSelectedId}
        />
        <ActionButton onClick={() => overviewQuery.refetch()}>
          {localize(locale, "刷新", "Refresh")}
        </ActionButton>
      </div>
      {overviewQuery.data ? (
        <>
          <ContextPackageCard overview={overviewQuery.data} />
          <GatePlanCard overview={overviewQuery.data} />
          <ClaimMatrixCard overview={overviewQuery.data} />
          <LaneSummaryCard overview={overviewQuery.data} />
          <ChannelCommandSummaryCard overview={overviewQuery.data} />
          <BlockersCard overview={overviewQuery.data} />
          <CloseoutReceiptCard overview={overviewQuery.data} />
        </>
      ) : (
        <ShellCard title={localize(locale, "选择一个任务工作流以查看监督员视图", "Select a task workflow to load the supervisor view")}>
          <p style={{ color: "#666", fontSize: "13px" }}>
            {localize(
              locale,
              "下拉框选择工作流后,将加载监督员视图。",
              "Use the dropdown above to pick a workflow and load its supervisor overview.",
            )}
          </p>
        </ShellCard>
      )}
      <EvidenceExplorerCard />
    </div>
  );
}
