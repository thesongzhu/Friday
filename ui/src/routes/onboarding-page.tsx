import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CheckCircle2, Globe2, LayoutGrid, UserRound } from "lucide-react";
import { ActionButton, ShellCard } from "@/components/core/primitives";
import { StepProgress, type StepProgressStep } from "@/components/guided/step-progress";
import { PackCard } from "@/components/packs/pack-card";
import { useUixPreferences } from "@/hooks/use-uix-preferences";
import { useUserProfile, type UserProfileType } from "@/hooks/use-user-profile";
import { getDefaultPinnedPackIds, getDefaultVisibleWidgets, getDefaultWidgetOrder, listPacksByKind, type HomeWidgetId } from "@/lib/packs/pack-registry";
import { cn } from "@/lib/utils/cn";
import { localize } from "@/lib/i18n/localized-text";
import { useAppLocale } from "@/providers/locale-provider";

type OnboardingStep = "language" | "profile" | "packs" | "widgets";

const ONBOARDING_STEP_ORDER: OnboardingStep[] = ["language", "profile", "packs", "widgets"];

const ONBOARDING_STEP_LABELS: Record<OnboardingStep, { zh: string; en: string }> = {
  language: { zh: "语言", en: "Language" },
  profile: { zh: "画像", en: "Profile" },
  packs: { zh: "入口", en: "Packs" },
  widgets: { zh: "模块", en: "Widgets" },
};

const PROFILE_OPTIONS: Array<{
  type: UserProfileType;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
}> = [
  {
    type: "developer",
    title: { zh: "开发者", en: "Developer" },
    description: { zh: "希望 Friday 帮我构建、修复、发布和做技术自动化。", en: "I want help building, fixing, shipping, and automating technical work." },
  },
  {
    type: "creator",
    title: { zh: "创作者", en: "Creator" },
    description: { zh: "我做内容，需要创作、复盘和跨平台运营支持。", en: "I create content and need help with production, review, and distribution." },
  },
  {
    type: "business",
    title: { zh: "经营者", en: "Business" },
    description: { zh: "我关心运营、电商、团队和经营决策。", en: "I care about operations, commerce, teams, and business decisions." },
  },
  {
    type: "beginner",
    title: { zh: "先探索", en: "Explorer" },
    description: { zh: "我先看看 Friday 能帮我做什么。", en: "I want to explore what Friday can do first." },
  },
];

const WIDGET_OPTIONS: Array<{ id: HomeWidgetId; title: { zh: string; en: string }; description: { zh: string; en: string } }> = [
  {
    id: "active_now",
    title: { zh: "正在进行", en: "Active Now" },
    description: { zh: "当前还没结束的任务和运行中的流程。", en: "Tasks and flows that are currently in progress." },
  },
  {
    id: "pending_approvals",
    title: { zh: "待确认", en: "Pending Approvals" },
    description: { zh: "需要你点一下确认的动作。", en: "Actions waiting on your approval." },
  },
  {
    id: "scheduled_soon",
    title: { zh: "即将执行", en: "Scheduled" },
    description: { zh: "已经排进节奏里的自动化。", en: "Recurring automations already scheduled." },
  },
  {
    id: "recent_results",
    title: { zh: "最近结果", en: "Recent Results" },
    description: { zh: "刚刚完成的事情和输出。", en: "The latest finished runs and outputs." },
  },
  {
    id: "recommended_to_add",
    title: { zh: "推荐加入", en: "Recommended" },
    description: { zh: "还没固定到首页，但适合你当前画像的入口。", en: "Suggested packs that fit your current profile." },
  },
];

export function OnboardingPage() {
  const navigate = useNavigate();
  const { locale, setLocale } = useAppLocale();
  const { setPreferences } = useUixPreferences();
  const { setProfileType, markOnboarded } = useUserProfile();
  // Language is now selected in setup — onboarding starts at profile selection.
  const [step, setStep] = useState<OnboardingStep>("profile");
  const [selectedProfile, setSelectedProfile] = useState<UserProfileType>("beginner");
  const [selectedPacks, setSelectedPacks] = useState<string[]>(getDefaultPinnedPackIds("beginner"));
  const [selectedWidgets, setSelectedWidgets] = useState<HomeWidgetId[]>(getDefaultVisibleWidgets());

  const industryPacks = useMemo(() => listPacksByKind("industry"), []);

  function applyProfile(profileType: UserProfileType) {
    setSelectedProfile(profileType);
    setProfileType(profileType);
    setSelectedPacks(getDefaultPinnedPackIds(profileType));
  }

  function togglePack(packId: string) {
    if (selectedPacks.includes(packId)) {
      setSelectedPacks((current) => current.filter((item) => item !== packId));
      return;
    }
    if (selectedPacks.length >= 3) {
      return;
    }
    setSelectedPacks((current) => [...current, packId]);
  }

  function toggleWidget(widgetId: HomeWidgetId) {
    setSelectedWidgets((current) =>
      current.includes(widgetId)
        ? current.filter((item) => item !== widgetId)
        : [...current, widgetId],
    );
  }

  function finishOnboarding() {
    const widgetOrder = getDefaultWidgetOrder();
    setPreferences({
      "display.locale": locale,
      "home.pinnedPackIds": selectedPacks,
      "home.packOrder": selectedPacks,
      "home.visibleWidgets": selectedWidgets,
      "home.widgetOrder": widgetOrder,
      "navigation.lastPrimarySurface": "home",
    });
    markOnboarded();
    navigate("/home", { replace: true });
  }

  const currentStepIdx = ONBOARDING_STEP_ORDER.indexOf(step);
  const onboardingSteps: StepProgressStep[] = ONBOARDING_STEP_ORDER.map((s, idx) => ({
    id: s,
    label: locale === "zh" ? ONBOARDING_STEP_LABELS[s].zh : ONBOARDING_STEP_LABELS[s].en,
    status: idx < currentStepIdx ? "completed" as const : idx === currentStepIdx ? "active" as const : "pending" as const,
  }));

  return (
    <div className="flex min-h-[calc(100vh-7rem)] items-center justify-center pb-6">
      <div className="w-full max-w-4xl space-y-5">
        <section className="rounded-[32px] border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] px-6 py-6 shadow-[var(--shadow-floating)]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-text-faint)]">
            {localize(locale, "开始使用 Friday", "Set up Friday")}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-[color:var(--color-text-primary)]">
            {localize(locale, "先把默认体验调顺，再开始做事", "Set the defaults once, then get to work")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[color:var(--color-text-secondary)]">
            {localize(
              locale,
              "这四步只会决定你首次看到的语言、首页入口和默认模块，之后都可以在产品里再改。",
              "These four steps only set your initial language, pinned packs, and default home widgets. You can change them later.",
            )}
          </p>
          {locale === "zh" && (
            <div className="mt-4">
              <StepProgress steps={onboardingSteps} orientation="horizontal" />
            </div>
          )}
        </section>

        {step === "language" ? (
          <ShellCard title={localize(locale, "1. 确认语言", "1. Choose Language")}>
            <div className="grid gap-4 md:grid-cols-2">
              {(["zh", "en"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setLocale(option)}
                  className={cn(
                    "rounded-[28px] border px-5 py-5 text-left transition",
                    locale === option
                      ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
                      : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] hover:border-[color:var(--color-border-strong)]",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2.5 text-[color:var(--color-accent)]">
                      <Globe2 className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-[color:var(--color-text-primary)]">
                        {option === "zh" ? "中文" : "English"}
                      </p>
                      <p className="text-sm text-[color:var(--color-text-secondary)]">
                        {option === "zh"
                          ? "界面将默认显示中文。"
                          : "The interface will default to English."}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-5 flex justify-end">
              <ActionButton onClick={() => setStep("profile")}>
                {localize(locale, "继续", "Continue")}
                <ArrowRight className="ml-2 h-4 w-4" />
              </ActionButton>
            </div>
          </ShellCard>
        ) : null}

        {step === "profile" ? (
          <ShellCard title={localize(locale, "2. 选择你的画像", "2. Choose Your Profile")}>
            <div className="grid gap-4 md:grid-cols-2">
              {PROFILE_OPTIONS.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => applyProfile(option.type)}
                  className={cn(
                    "rounded-[28px] border px-5 py-5 text-left transition",
                    selectedProfile === option.type
                      ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
                      : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] hover:border-[color:var(--color-border-strong)]",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2.5 text-[color:var(--color-accent)]">
                      <UserRound className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-[color:var(--color-text-primary)]">
                        {locale === "zh" ? option.title.zh : option.title.en}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                        {locale === "zh" ? option.description.zh : option.description.en}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between">
              <ActionButton tone="secondary" onClick={() => setStep("language")}>
                {localize(locale, "返回", "Back")}
              </ActionButton>
              <ActionButton onClick={() => setStep("packs")}>
                {localize(locale, "继续", "Continue")}
                <ArrowRight className="ml-2 h-4 w-4" />
              </ActionButton>
            </div>
          </ShellCard>
        ) : null}

        {step === "packs" ? (
          <ShellCard title={localize(locale, "3. 选择 3 个 starter packs", "3. Pick 3 starter packs")}>
            <div className="grid gap-4 md:grid-cols-2">
              {industryPacks.map((pack) => (
                <div key={pack.id} className={cn(selectedPacks.includes(pack.id) && "ring-2 ring-[color:var(--color-accent)] ring-offset-2 ring-offset-[color:var(--color-bg-base)]")}>
                  <PackCard
                    pack={pack}
                    pinned={selectedPacks.includes(pack.id)}
                    onOpen={() => togglePack(pack.id)}
                    note={selectedPacks.includes(pack.id)
                      ? localize(locale, "这个入口会固定在首页。", "This pack will be pinned to home.")
                      : localize(locale, "点击加入首页。", "Tap to pin this pack to home.")}
                  />
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between gap-3">
              <p className="text-sm text-[color:var(--color-text-secondary)]">
                {selectedPacks.length < 3
                  ? localize(locale, `请选择 3 个场景包 (已选 ${selectedPacks.length})`, `Select 3 packs to continue (${selectedPacks.length} selected)`)
                  : localize(locale, `已选择 ${selectedPacks.length} / 3`, `${selectedPacks.length} / 3 selected`)}
              </p>
              <div className="flex gap-2">
                <ActionButton tone="secondary" onClick={() => setStep("profile")}>
                  {localize(locale, "返回", "Back")}
                </ActionButton>
                <ActionButton onClick={() => setStep("widgets")} disabled={selectedPacks.length !== 3}>
                  {localize(locale, "继续", "Continue")}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </ActionButton>
              </div>
            </div>
          </ShellCard>
        ) : null}

        {step === "widgets" ? (
          <ShellCard title={localize(locale, "4. 选择默认首页模块", "4. Choose default home widgets")}>
            <div className="grid gap-4 md:grid-cols-2">
              {WIDGET_OPTIONS.map((widget) => (
                <button
                  key={widget.id}
                  type="button"
                  onClick={() => toggleWidget(widget.id)}
                  className={cn(
                    "rounded-[28px] border px-5 py-5 text-left transition",
                    selectedWidgets.includes(widget.id)
                      ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]"
                      : "border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-subtle)] hover:border-[color:var(--color-border-strong)]",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-bg-surface)] p-2.5 text-[color:var(--color-accent)]">
                      {selectedWidgets.includes(widget.id) ? <CheckCircle2 className="h-5 w-5" /> : <LayoutGrid className="h-5 w-5" />}
                    </div>
                    <div>
                      <p className="text-base font-semibold text-[color:var(--color-text-primary)]">
                        {locale === "zh" ? widget.title.zh : widget.title.en}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-[color:var(--color-text-secondary)]">
                        {locale === "zh" ? widget.description.zh : widget.description.en}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between gap-3">
              <ActionButton tone="secondary" onClick={() => setStep("packs")}>
                {localize(locale, "返回", "Back")}
              </ActionButton>
              <ActionButton onClick={finishOnboarding} disabled={selectedWidgets.length === 0}>
                {localize(locale, "进入首页", "Go To Home")}
                <ArrowRight className="ml-2 h-4 w-4" />
              </ActionButton>
            </div>
          </ShellCard>
        ) : null}
      </div>
    </div>
  );
}
