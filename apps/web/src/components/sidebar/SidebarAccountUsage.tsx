import { useAtomValue } from "@effect/atom-react";
import type { LateShiftUsageBudget, LateShiftUsageProvider } from "@t3tools/contracts";
import { GithubIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { primaryUsageBudgetAtom } from "../../state/server";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";

const formatUsd = (value: number): string => `$${value.toFixed(2)}`;

const percentOf = (used: number, limit: number | null): number =>
  limit !== null && limit > 0 ? Math.round((used / limit) * 100) : 0;

const formatResetTime = (iso: string | null): string | null => {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** Tightest (highest-percent) configured constraint, 0..1, or null when nothing is limited. */
const tightestRatio = (budget: LateShiftUsageBudget): number | null => {
  const ratios: number[] = [];
  if (budget.totalLimitUsd !== null && budget.totalLimitUsd > 0) {
    ratios.push(budget.totalUsedUsd / budget.totalLimitUsd);
  }
  for (const provider of budget.providers) {
    if (provider.monthLimitUsd !== null && provider.monthLimitUsd > 0) {
      ratios.push(provider.monthUsedUsd / provider.monthLimitUsd);
    }
    if (provider.windowLimitUsd !== null && provider.windowLimitUsd > 0) {
      ratios.push(provider.windowUsedUsd / provider.windowLimitUsd);
    }
  }
  if (ratios.length === 0) return null;
  return Math.min(1, Math.max(0, Math.max(...ratios)));
};

function UsageRing({ ratio }: { ratio: number }) {
  const size = 20;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, ratio));
  const color =
    clamped >= 1 ? "text-red-500" : clamped >= 0.8 ? "text-amber-500" : "text-emerald-500";
  return (
    <svg
      aria-hidden="true"
      className="-rotate-90 shrink-0"
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      <circle
        className="stroke-sidebar-border/60"
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        strokeWidth={stroke}
      />
      <circle
        className={cn("transition-all", color)}
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        strokeLinecap="round"
        strokeWidth={stroke}
      />
    </svg>
  );
}

function ProviderUsageLines({ provider }: { provider: LateShiftUsageProvider }) {
  const reset = formatResetTime(provider.windowResetsAt);
  const hasWindow = provider.windowLimitUsd !== null;
  const hasMonth = provider.monthLimitUsd !== null;
  if (!hasWindow && !hasMonth) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-xs font-medium text-sidebar-foreground">{provider.label}</div>
      {provider.windowLimitUsd !== null ? (
        <div className="text-xs text-sidebar-muted-foreground">
          {formatUsd(provider.windowUsedUsd)} of {formatUsd(provider.windowLimitUsd)} this session
          {reset !== null ? ` — resets ${reset}` : ""}
        </div>
      ) : null}
      {provider.monthLimitUsd !== null ? (
        <div className="text-xs text-sidebar-muted-foreground">
          {formatUsd(provider.monthUsedUsd)} of {formatUsd(provider.monthLimitUsd)} this month (
          {percentOf(provider.monthUsedUsd, provider.monthLimitUsd)}%)
        </div>
      ) : null}
    </div>
  );
}

/**
 * LateShift Cloud account + usage chip shown in the sidebar footer. Renders the
 * signed-in GitHub account and a budget ring (tightest of the 5h-session and
 * monthly limits); clicking opens a per-provider usage breakdown. Hidden
 * gracefully when the instance provides neither identity nor any limit.
 */
export const SidebarAccountUsage = memo(function SidebarAccountUsage() {
  const budget = useAtomValue(primaryUsageBudgetAtom);
  if (budget === null) return null;
  const ratio = tightestRatio(budget);
  if (budget.userName === null && ratio === null) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover>
          <PopoverTrigger
            className={cn(
              "flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left outline-hidden ring-ring focus-visible:ring-2",
              "hover:bg-sidebar-row-hover",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {budget.userName !== null ? (
                <>
                  <GithubIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
                  <span className="truncate text-sm font-medium text-sidebar-foreground">
                    {budget.userName}
                  </span>
                </>
              ) : (
                <span className="truncate text-sm font-medium text-sidebar-muted-foreground">
                  Usage
                </span>
              )}
            </span>
            {ratio !== null ? <UsageRing ratio={ratio} /> : null}
          </PopoverTrigger>
          <PopoverPopup align="start" className="w-64" side="top">
            <div className="flex flex-col gap-2.5">
              {budget.providers.map((provider) => (
                <ProviderUsageLines key={provider.id} provider={provider} />
              ))}
              {budget.totalLimitUsd !== null ? (
                <div className="border-t border-sidebar-border/60 pt-2 text-xs font-medium text-sidebar-foreground">
                  Total: {formatUsd(budget.totalUsedUsd)} of {formatUsd(budget.totalLimitUsd)} (
                  {percentOf(budget.totalUsedUsd, budget.totalLimitUsd)}%)
                </div>
              ) : null}
              <div className="text-[10px] leading-tight text-sidebar-muted-foreground/70">
                Session figures approximate each provider&apos;s own 5-hour usage window.
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
});
