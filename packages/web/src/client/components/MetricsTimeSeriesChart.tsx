"use client"

import { useMemo } from "react"
import { Area, AreaChart, CartesianGrid, ReferenceArea, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "./ui/chart"
import type { RunWindow } from "../hooks/useMetricsTimeSeries"

const TIME_RANGES = [
  { label: "30m", hours: 0.5 },
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
] as const

const chartConfig = {
  cpu: {
    label: "CPU",
    color: "var(--chart-1)",
  },
  memory: {
    label: "Memory",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

function RunBanner({ run, y }: { run: RunWindow; y: number }) {
  const x1 = new Date(run.startedAt).getTime()
  const x2 = new Date(run.completedAt).getTime()
  return (
    <ReferenceArea
      x1={x1}
      x2={x2}
      fill="var(--chart-5)"
      fillOpacity={0.08}
      stroke="var(--chart-5)"
      strokeOpacity={0.15}
      strokeWidth={0.5}
      label={
        y === 0
          ? {
              value: run.agent ? `${run.name} (${run.agent})` : run.name,
              position: "insideTopLeft",
              fontSize: 9,
              fill: "var(--chart-5)",
              offset: 4,
            }
          : undefined
      }
    />
  )
}

interface Props {
  dataPoints: Array<{ recordedAt: string; cpuPct: number; memPct: number }>
  runWindows: RunWindow[]
  nodeNames: string[]
  hours: number
  selectedNode: string
  onHoursChange: (h: number) => void
  onNodeChange: (n: string) => void
  loading?: boolean
  error?: Error | null
}

export default function MetricsTimeSeriesChart({
  dataPoints,
  runWindows,
  nodeNames,
  hours,
  selectedNode,
  onHoursChange,
  onNodeChange,
  loading,
  error,
}: Props) {
  const chartData = useMemo(() => {
    return dataPoints.map((p) => ({
      time: new Date(p.recordedAt).getTime(),
      cpu: p.cpuPct,
      memory: p.memPct,
    }))
  }, [dataPoints])

  const timeRangeLabel = TIME_RANGES.find((t) => t.hours === hours)?.label ?? `${hours}h`

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-500">Failed to load metrics history: {error.message}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 space-y-0 border-b py-5 sm:flex-row">
        <div className="grid flex-1 gap-1">
          <CardTitle>History</CardTitle>
          <CardDescription>
            CPU &amp; memory utilization over the last {timeRangeLabel.toLowerCase()}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedNode} onValueChange={onNodeChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All nodes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All nodes</SelectItem>
              {nodeNames.map((n) => (
                <SelectItem key={n} value={n}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(hours)}
            onValueChange={(v) => onHoursChange(parseFloat(v))}
          >
            <SelectTrigger className="w-[80px]">
              <SelectValue placeholder="1h" />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((t) => (
                <SelectItem key={t.hours} value={String(t.hours)}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {loading && chartData.length === 0 ? (
          <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground">
            Loading...
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground">
            No data yet — metrics collector is gathering snapshots every 30s.
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[250px] w-full"
          >
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="fillCpu" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-cpu)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--color-cpu)" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="fillMemory" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-memory)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--color-memory)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(t: number) => {
                  const d = new Date(t)
                  return Number.isFinite(d.getTime()) ? fmtTime(d.toISOString()) : ""
                }}
                minTickGap={48}
              />
              <YAxis
                type="number"
                domain={[0, 100]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v: number) => `${v}%`}
                width={36}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(label, payload) => {
                      if (!payload.length) return String(label)
                      const p = payload[0] as Record<string, unknown>
                      const time = (p?.payload as Record<string, unknown>)?.time as number | undefined
                      return time ? fmtTime(new Date(time).toISOString()) : String(label)
                    }}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {runWindows.map((rw) => (
                <RunBanner key={rw.name} run={rw} y={0} />
              ))}
              <Area
                dataKey="cpu"
                type="monotone"
                fill="url(#fillCpu)"
                stroke="var(--color-cpu)"
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
              <Area
                dataKey="memory"
                type="monotone"
                fill="url(#fillMemory)"
                stroke="var(--color-memory)"
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
