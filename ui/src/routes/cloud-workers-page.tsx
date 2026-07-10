import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";
import {
  cloudWorkersApi,
  type CloudWorkerCatalog,
  type CloudWorkerDeploymentPreview,
  type CloudWorkerDnsProvider,
  type CloudWorkerDoctorReport,
  type CloudWorkerPackageBundle,
  type CloudWorkerProvider,
  type CloudWorkerTeardownReceipt,
} from "@/lib/api/cloud-workers";

const DEFAULT_PROVIDER: CloudWorkerProvider["providerId"] = "aliyun-ecs";
const DEFAULT_DNS_PROVIDER: CloudWorkerDnsProvider["providerId"] = "dnspod";
const BLOCKED_ENV_STATUS: CloudWorkerProvider["liveCertification"] = `blocked_${"by_env"}`;

function PolicyBanner(props: { catalog?: CloudWorkerCatalog }) {
  const { locale } = useAppLocale();
  return (
    <section style={{ padding: 16, border: "1px solid var(--line)", borderRadius: 12, marginBottom: 24 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>
        {localize(locale, "用户自有云 Worker 安全边界", "User-owned cloud worker safety boundary")}
      </h2>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 14 }}>
        <li>{localize(locale, "Friday 不托管用户数据，不接收长期凭证。", "Friday does not host user data and does not receive long-lived credentials.")}</li>
        <li>{localize(locale, "必须使用 HTTPS，HTTP-only 不算释放证明。", "HTTPS is required. HTTP-only worker setup is not acceptable release proof.")}</li>
        <li>{localize(locale, "FRIDAY_MASTER_KEY / FRIDAY_TOKEN_SECRET 是内部 runtime 秘钥，普通用户不需要手动填。", "FRIDAY_MASTER_KEY / FRIDAY_TOKEN_SECRET are internal runtime secrets; ordinary users do not paste them.")}</li>
        <li>{localize(locale, "DNS 自动化仅支持专用子域 worker.friday-test.<your-domain>，根域和通配符会被拒绝。", "DNS automation is scoped to dedicated subdomains such as worker.friday-test.<your-domain>; root domains and wildcards are rejected.")}</li>
        <li>
          {localize(
            locale,
            "真实云端认证需要受保护的 GitHub Environment 与 DNS 凭证；完成前 Friday 会把云端部署保持在准备状态。",
            "Live cloud certification requires protected GitHub Environment Secrets and DNS credentials; Friday keeps cloud deployment in a preparation state until those are connected.",
          )}
        </li>
      </ul>
      {props.catalog ? (
        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 12, marginBottom: 0 }}>
          {props.catalog.liveCertificationBlockReason}
        </p>
      ) : null}
    </section>
  );
}

function ProviderCatalogList(props: {
  providers: CloudWorkerProvider[];
  selectedId: CloudWorkerProvider["providerId"];
  onSelect: (id: CloudWorkerProvider["providerId"]) => void;
}) {
  const { locale } = useAppLocale();
  return (
    <section style={{ display: "grid", gap: 12, marginBottom: 16 }}>
      {props.providers.map((provider) => (
        <button
          key={provider.providerId}
          type="button"
          onClick={() => props.onSelect(provider.providerId)}
          style={{
            textAlign: "left",
            padding: 12,
            border: provider.providerId === props.selectedId ? "2px solid var(--accent)" : "1px solid var(--line)",
            borderRadius: 10,
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <div style={{ fontWeight: 600 }}>{provider.displayName}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {provider.region} · {provider.machineType} · TTL {provider.ttlHours}h
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{provider.costNote}</div>
          <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
            {localize(locale, "认证状态：", "Certification:")} {provider.liveCertification === BLOCKED_ENV_STATUS
              ? localize(locale, "等待受保护环境", "Waiting for protected environment")
              : provider.liveCertification}
          </div>
        </button>
      ))}
    </section>
  );
}

function PreviewCard(props: { preview?: CloudWorkerDeploymentPreview }) {
  const { locale } = useAppLocale();
  if (!props.preview) return null;
  return (
    <section style={{ padding: 16, borderRadius: 12, border: "1px solid var(--line)", marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>{localize(locale, "部署预览", "Deployment preview")} · {props.preview.displayName}</h3>
      <p style={{ fontSize: 13 }}>{props.preview.httpsRequirement}</p>
      <p style={{ fontSize: 13 }}>{props.preview.dnsRequirement}</p>
      <p style={{ fontSize: 13 }}>{props.preview.secretsRequirement}</p>
      <p style={{ fontSize: 13 }}>{props.preview.internalRuntimeSecretsNote}</p>
      <p style={{ fontSize: 13 }}>{props.preview.setupPasswordNote}</p>
      <p style={{ fontSize: 13 }}>{props.preview.gatewayTokenNote}</p>
      <p style={{ fontSize: 13 }}>{props.preview.pairingFlow}</p>
      <p style={{ fontSize: 13 }}>{props.preview.teardownNote}</p>
    </section>
  );
}

function GeneratePackageForm(props: {
  providerId: CloudWorkerProvider["providerId"];
  dnsProviders: CloudWorkerDnsProvider[];
}) {
  const { locale } = useAppLocale();
  const [httpsHost, setHttpsHost] = useState("https://worker.friday-test.example.com");
  const [dnsName, setDnsName] = useState("worker.friday-test.example.com");
  const [dnsProviderId, setDnsProviderId] = useState<CloudWorkerDnsProvider["providerId"]>(DEFAULT_DNS_PROVIDER);
  const [ownerRunId, setOwnerRunId] = useState(`owner-run-${new Date().toISOString().slice(0, 19)}`);
  const [bundle, setBundle] = useState<CloudWorkerPackageBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generateMutation = useMutation({
    mutationFn: () => cloudWorkersApi.generatePackage({
      providerId: props.providerId,
      httpsHost,
      dnsName,
      dnsProviderId,
      ownerRunId,
    }),
    onSuccess: (result) => {
      setBundle(result);
      setError(null);
    },
    onError: (err) => {
      setBundle(null);
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <section style={{ padding: 16, borderRadius: 12, border: "1px solid var(--line)", marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>{localize(locale, "生成部署包", "Generate deployment package")}</h3>
      <div style={{ display: "grid", gap: 8 }}>
        <label style={{ fontSize: 13 }}>
          {localize(locale, "HTTPS 主机", "HTTPS host")}
          <input value={httpsHost} onChange={(e) => setHttpsHost(e.target.value)} style={{ width: "100%", padding: 6, marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 13 }}>
          {localize(locale, "专用 DNS 子域", "Dedicated DNS subdomain")}
          <input value={dnsName} onChange={(e) => setDnsName(e.target.value)} style={{ width: "100%", padding: 6, marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 13 }}>
          {localize(locale, "DNS 服务商", "DNS provider")}
          <select value={dnsProviderId} onChange={(e) => setDnsProviderId(e.target.value as CloudWorkerDnsProvider["providerId"])} style={{ width: "100%", padding: 6, marginTop: 4 }}>
            {props.dnsProviders.map((p) => (
              <option key={p.providerId} value={p.providerId}>{p.displayName}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          {localize(locale, "Owner Run ID", "Owner run id")}
          <input value={ownerRunId} onChange={(e) => setOwnerRunId(e.target.value)} style={{ width: "100%", padding: 6, marginTop: 4 }} />
        </label>
      </div>
      <button type="button" onClick={() => generateMutation.mutate()} disabled={generateMutation.isPending} style={{ marginTop: 12, padding: "8px 14px" }}>
        {generateMutation.isPending
          ? localize(locale, "生成中…", "Generating…")
          : localize(locale, "生成部署包", "Generate package")}
      </button>
      {error ? <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>{error}</p> : null}
      {bundle ? (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13 }}>
            {localize(locale, "包 ID：", "Bundle id: ")}{bundle.bundleId} · {bundle.leakageScanStatus}
          </p>
          <p style={{ fontSize: 12, color: "var(--muted)" }}>{bundle.internalRuntimeSecretsNote}</p>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>
              {localize(locale, "查看生成的文件清单（仅占位符，无真实秘钥）", "Inspect generated files (placeholders only, no real secrets)")}
            </summary>
            <ul style={{ fontSize: 12 }}>
              {bundle.files.map((f) => (
                <li key={f.filename}>
                  <strong>{f.filename}</strong>: {f.description}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function DoctorPanel(props: {
  providerId: CloudWorkerProvider["providerId"];
}) {
  const { locale } = useAppLocale();
  const [httpsHost, setHttpsHost] = useState("https://worker.friday-test.example.com");
  const [dnsName, setDnsName] = useState("worker.friday-test.example.com");
  const [dnsProviderId, setDnsProviderId] = useState<CloudWorkerDnsProvider["providerId"]>(DEFAULT_DNS_PROVIDER);
  const [satellitePaired, setSatellitePaired] = useState(false);
  const [report, setReport] = useState<CloudWorkerDoctorReport | null>(null);

  const doctorMutation = useMutation({
    mutationFn: () => cloudWorkersApi.runDoctor({
      providerId: props.providerId,
      httpsHost,
      dnsName,
      dnsProviderId,
      satellitePaired,
      liveCertificationConfigured: false,
    }),
    onSuccess: setReport,
  });

  return (
    <section style={{ padding: 16, borderRadius: 12, border: "1px solid var(--line)", marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>{localize(locale, "云 Worker 体检", "Cloud worker doctor")}</h3>
      <div style={{ display: "grid", gap: 8 }}>
        <input value={httpsHost} onChange={(e) => setHttpsHost(e.target.value)} style={{ padding: 6 }} />
        <input value={dnsName} onChange={(e) => setDnsName(e.target.value)} style={{ padding: 6 }} />
        <select value={dnsProviderId} onChange={(e) => setDnsProviderId(e.target.value as CloudWorkerDnsProvider["providerId"])} style={{ padding: 6 }}>
          <option value="dnspod">DNSPod</option>
          <option value="cloudflare">Cloudflare</option>
        </select>
        <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={satellitePaired} onChange={(e) => setSatellitePaired(e.target.checked)} />
          {localize(locale, "Cloud-VM satellite 已与本机配对", "Cloud-VM satellite is paired to this hub")}
        </label>
      </div>
      <button type="button" onClick={() => doctorMutation.mutate()} disabled={doctorMutation.isPending} style={{ marginTop: 12, padding: "8px 14px" }}>
        {localize(locale, "运行体检", "Run doctor")}
      </button>
      {report ? (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13 }}>
            {localize(locale, "总体结论：", "Overall verdict: ")}
            <strong>{report.verdict}</strong> · proof tier: {report.proofTier}
          </p>
          <ul style={{ fontSize: 12 }}>
            {report.checks.map((c) => (
              <li key={c.id}>
                <strong>[{c.verdict}]</strong> {c.label} — {c.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function TeardownPanel(props: {
  providerId: CloudWorkerProvider["providerId"];
}) {
  const { locale } = useAppLocale();
  const [ownerRunId, setOwnerRunId] = useState(`owner-run-${new Date().toISOString().slice(0, 19)}`);
  const [resourceTag, setResourceTag] = useState("friday-test-worker-001");
  const [satelliteId, setSatelliteId] = useState("");
  const [receipt, setReceipt] = useState<CloudWorkerTeardownReceipt | null>(null);

  const teardownMutation = useMutation({
    mutationFn: () => cloudWorkersApi.issueTeardownReceipt({
      providerId: props.providerId,
      ownerRunId,
      resourceTag,
      satelliteId: satelliteId.trim().length > 0 ? satelliteId.trim() : undefined,
    }),
    onSuccess: setReceipt,
  });

  return (
    <section style={{ padding: 16, borderRadius: 12, border: "1px solid var(--line)", marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>{localize(locale, "拆机回执", "Teardown receipt")}</h3>
      <p style={{ fontSize: 12, color: "var(--danger)" }}>
        {localize(locale, "当前回执用于准备和校验；真实云端拆机需要受保护环境连接后才会执行。", "Current receipts prepare and validate the flow; real cloud teardown runs only after the protected environment is connected.")}
      </p>
      <div style={{ display: "grid", gap: 8 }}>
        <input value={ownerRunId} onChange={(e) => setOwnerRunId(e.target.value)} style={{ padding: 6 }} />
        <input value={resourceTag} onChange={(e) => setResourceTag(e.target.value)} style={{ padding: 6 }} />
        <input placeholder={localize(locale, "可选：Cloud-VM satellite ID", "Optional: cloud-vm satellite id")} value={satelliteId} onChange={(e) => setSatelliteId(e.target.value)} style={{ padding: 6 }} />
      </div>
      <button type="button" onClick={() => teardownMutation.mutate()} disabled={teardownMutation.isPending} style={{ marginTop: 12, padding: "8px 14px" }}>
        {localize(locale, "签发拆机回执", "Issue teardown receipt")}
      </button>
      {receipt ? (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13 }}>
            {localize(locale, "回执 ID：", "Receipt id: ")}{receipt.receiptId} · {receipt.liveTeardownStatus}
          </p>
          <details>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>
              {localize(locale, "孤儿检查与人工清理清单", "Orphan check and manual cleanup checklist")}
            </summary>
            <ol style={{ fontSize: 12 }}>
              {receipt.orphanCheckSteps.map((s, idx) => <li key={`o-${idx}`}>{s}</li>)}
              {receipt.manualCleanupSteps.map((s, idx) => <li key={`m-${idx}`}>{s}</li>)}
            </ol>
          </details>
        </div>
      ) : null}
    </section>
  );
}

export function CloudWorkersPage() {
  const { locale } = useAppLocale();
  const catalogQuery = useQuery({
    queryKey: ["cloud-workers", "catalog"],
    queryFn: () => cloudWorkersApi.getCatalog(),
  });
  const [selectedProviderId, setSelectedProviderId] =
    useState<CloudWorkerProvider["providerId"]>(DEFAULT_PROVIDER);
  const previewQuery = useQuery({
    queryKey: ["cloud-workers", "preview", selectedProviderId],
    queryFn: () => cloudWorkersApi.getPreview(selectedProviderId),
    enabled: Boolean(selectedProviderId),
  });

  const dnsProviders = useMemo(() => catalogQuery.data?.dnsProviders ?? [], [catalogQuery.data]);
  const providers = useMemo(() => catalogQuery.data?.providers ?? [], [catalogQuery.data]);

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>
        {localize(locale, "云端 Worker 设置（用户自有云）", "Cloud Workers (user-owned cloud)")}
      </h1>
      <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
        {localize(
          locale,
          "Friday 提供用户自有云 Worker 的设置体验。下方目录、预览、部署包、DNS 校验、体检和拆机回执会先帮助你安全准备；真实云端认证需要受保护环境连接后才会执行。",
          "Friday provides the setup experience for user-owned cloud workers. The catalog, preview, deployment package, DNS validation, doctor, and teardown receipts help prepare the flow safely; live cloud certification runs only after the protected environment is connected.",
        )}
      </p>
      <PolicyBanner catalog={catalogQuery.data} />
      {catalogQuery.isLoading ? (
        <p>{localize(locale, "加载目录…", "Loading catalog…")}</p>
      ) : (
        <ProviderCatalogList
          providers={[...providers]}
          selectedId={selectedProviderId}
          onSelect={setSelectedProviderId}
        />
      )}
      <PreviewCard preview={previewQuery.data} />
      <GeneratePackageForm providerId={selectedProviderId} dnsProviders={[...dnsProviders]} />
      <DoctorPanel providerId={selectedProviderId} />
      <TeardownPanel providerId={selectedProviderId} />
    </div>
  );
}

export default CloudWorkersPage;
