import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Cpu, MessageSquare, MousePointer2, PenTool, Search, Users, Wrench } from "lucide-react";
import { useUserProfile, type UserProfileType } from "@/hooks/use-user-profile";
import { ChoiceCard } from "@/components/guided/choice-card";
import { ActionButton } from "@/components/core/primitives";
import { cn } from "@/lib/utils/cn";

type OnboardingStep = "welcome" | "profile" | "ready";

const PROFILE_CHOICES: Array<{
  type: UserProfileType;
  title: string;
  description: string;
  outcome: string;
  icon: typeof Wrench;
}> = [
  {
    type: "developer",
    title: "Developer",
    description: "I write code and want help shipping, testing, reviewing, and automating my workflow.",
    outcome: "Friday prioritizes build, fix, ship, and AI/SaaS goals.",
    icon: Wrench,
  },
  {
    type: "creator",
    title: "Creator",
    description: "I make content and want help creating, scheduling, and distributing across platforms.",
    outcome: "Friday prioritizes content creation, social media, and automation goals.",
    icon: PenTool,
  },
  {
    type: "business",
    title: "Business",
    description: "I run a business and want help with operations, e-commerce, team, and data analysis.",
    outcome: "Friday prioritizes e-commerce, team management, and trading goals.",
    icon: Users,
  },
  {
    type: "beginner",
    title: "Just exploring",
    description: "I'm new and want to see what Friday can do. Show me everything.",
    outcome: "Friday shows all goals with gentle guidance.",
    icon: Search,
  },
];

function WelcomeStep(props: { onContinue: () => void }) {
  const steps = [
    {
      icon: MessageSquare,
      title: "Tell Friday your goal",
      description: "Pick what you want to achieve. No technical knowledge needed.",
    },
    {
      icon: Search,
      title: "Friday investigates",
      description: "Friday researches your situation, analyzes options, and finds the best approach.",
    },
    {
      icon: MousePointer2,
      title: "You click to decide",
      description: "Friday presents clear options with recommendations. You just click to choose.",
    },
  ];

  return (
    <div className="space-y-8">
      <div className="text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent-strong)]">
          Welcome to Friday
        </p>
        <h1 className="mt-3 font-[var(--font-display)] text-3xl font-semibold tracking-tight text-white">
          Your AI assistant that gets things done
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-white/50">
          Friday helps you achieve complex goals with simple clicks. Here's how it works:
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {steps.map((step, index) => (
          <div
            key={step.title}
            className="rounded-3xl border border-white/10 bg-white/[0.02] p-5 text-center"
          >
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06]">
              <step.icon className="h-5 w-5 text-[var(--accent-strong)]" />
            </div>
            <p className="mt-3 text-sm font-semibold text-white">{step.title}</p>
            <p className="mt-1.5 text-xs leading-5 text-white/50">{step.description}</p>
          </div>
        ))}
      </div>

      <div className="text-center">
        <ActionButton onClick={props.onContinue} className="px-8">
          Get started
          <ArrowRight className="ml-2 h-4 w-4" />
        </ActionButton>
      </div>
    </div>
  );
}

function ProfileStep(props: { onSelect: (type: UserProfileType) => void; selected: UserProfileType | null }) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="font-[var(--font-display)] text-2xl font-semibold tracking-tight text-white">
          What describes you best?
        </h2>
        <p className="mt-2 text-sm text-white/50">
          This helps Friday show you the most relevant goals first. You can change this later.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PROFILE_CHOICES.map((choice) => (
          <ChoiceCard
            key={choice.type}
            title={choice.title}
            description={choice.description}
            outcome={choice.outcome}
            selected={props.selected === choice.type}
            onSelect={() => props.onSelect(choice.type)}
          />
        ))}
      </div>
    </div>
  );
}

function ReadyStep(props: { profileType: UserProfileType; onFinish: () => void }) {
  const labels: Record<UserProfileType, string> = {
    developer: "Developer",
    creator: "Creator",
    business: "Business",
    beginner: "Explorer",
  };

  return (
    <div className="space-y-6 text-center">
      <div>
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl border border-emerald-400/20 bg-emerald-400/10">
          <Cpu className="h-7 w-7 text-emerald-300" />
        </div>
        <h2 className="mt-4 font-[var(--font-display)] text-2xl font-semibold tracking-tight text-white">
          You're all set
        </h2>
        <p className="mt-2 text-sm text-white/50">
          Friday is configured for you as a <span className="font-medium text-white/70">{labels[props.profileType]}</span>.
          Your home screen will show the most relevant goals for you.
        </p>
      </div>

      <ActionButton onClick={props.onFinish} className="px-8">
        Go to Home
        <ArrowRight className="ml-2 h-4 w-4" />
      </ActionButton>
    </div>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const { setProfileType, markOnboarded } = useUserProfile();
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [selectedProfile, setSelectedProfile] = useState<UserProfileType | null>(null);

  function handleProfileSelect(type: UserProfileType) {
    setSelectedProfile(type);
    setProfileType(type);
    setStep("ready");
  }

  function handleFinish() {
    markOnboarded();
    navigate("/home", { replace: true });
  }

  return (
    <div className="flex min-h-[calc(100vh-6rem)] items-center justify-center px-4">
      <div className="w-full max-w-2xl">
        {step === "welcome" && <WelcomeStep onContinue={() => setStep("profile")} />}
        {step === "profile" && (
          <ProfileStep selected={selectedProfile} onSelect={handleProfileSelect} />
        )}
        {step === "ready" && selectedProfile && (
          <ReadyStep profileType={selectedProfile} onFinish={handleFinish} />
        )}

        {/* Step indicators */}
        <div className="mt-8 flex items-center justify-center gap-2">
          {(["welcome", "profile", "ready"] as const).map((s) => (
            <div
              key={s}
              className={cn(
                "h-1.5 rounded-full transition-all",
                s === step ? "w-6 bg-[var(--accent-strong)]" : "w-1.5 bg-white/20",
              )}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
