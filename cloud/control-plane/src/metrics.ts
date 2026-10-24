/**
 * Hand-rolled Prometheus text registry (REQ-B-20) — no new dependency.
 * Counters, gauges (static or callback), and fixed-bucket histograms with
 * label support; `render()` produces the exposition format.
 */

export type MetricLabels = Record<string, string>;

const DURATION_BUCKETS_SECONDS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

function labelKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${labels[k].replace(/"/g, '')}"`).join(',');
}

function labelsSuffix(labels: MetricLabels): string {
  const key = labelKey(labels);
  return key ? `{${key}}` : '';
}

interface HistogramState {
  labels: MetricLabels;
  labelKey: string;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, { labels: MetricLabels; value: number }>();
  private readonly gauges = new Map<string, { labels: MetricLabels; value: number | (() => number) }>();
  private readonly histograms = new Map<string, HistogramState>();

  inc(name: string, labels: MetricLabels = {}, by = 1): void {
    const key = `${name}${labelsSuffix(labels)}`;
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.counters.set(key, { labels, value: by });
    }
  }

  setGauge(name: string, labels: MetricLabels, value: number): void {
    this.gauges.set(`${name}${labelsSuffix(labels)}`, { labels, value });
  }

  /** Lazy gauge evaluated at scrape time (e.g. open socket count). */
  gaugeFn(name: string, fn: () => number): void {
    this.gauges.set(`${name}`, { labels: {}, value: fn });
  }

  observe(name: string, labels: MetricLabels, value: number, buckets = DURATION_BUCKETS_SECONDS): void {
    const key = `${name}${labelsSuffix(labels)}`;
    let state = this.histograms.get(key);
    if (!state) {
      state = { labels, labelKey: labelKey(labels), buckets, counts: buckets.map(() => 0), sum: 0, count: 0 };
      this.histograms.set(key, state);
    }
    state.sum += value;
    state.count += 1;
    for (let i = 0; i < state.buckets.length; i += 1) {
      if (value <= state.buckets[i]) {
        state.counts[i] += 1;
      }
    }
  }

  /** REQ-B-20 convenience series. */
  httpRequest(route: string, status: number): void {
    this.inc('cp_http_requests_total', { route, status: String(status) });
  }

  smsSend(purpose: string, delivered: boolean): void {
    this.inc('cp_sms_sends_total', { purpose, result: delivered ? 'ok' : 'failed' });
  }

  provisioningDuration(seconds: number): void {
    this.observe('cp_provisioning_duration_seconds', {}, seconds);
  }

  upgradeDuration(seconds: number, result: 'upgraded' | 'rolled-back'): void {
    this.observe('cp_upgrade_duration_seconds', { result }, seconds);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, gauge] of [...this.gauges.entries()].sort()) {
      const value = typeof gauge.value === 'function' ? gauge.value() : gauge.value;
      lines.push(`# TYPE ${name.split('{')[0]} gauge`, `${name} ${value}`);
    }
    for (const [name, counter] of [...this.counters.entries()].sort()) {
      lines.push(`# TYPE ${name.split('{')[0]} counter`, `${name} ${counter.value}`);
    }
    for (const [name, histogram] of [...this.histograms.entries()].sort()) {
      const base = name.split('{')[0];
      lines.push(`# TYPE ${base} histogram`);
      for (let i = 0; i < histogram.buckets.length; i += 1) {
        const leLabel = histogram.labelKey ? `${histogram.labelKey},` : '';
        lines.push(`${base}_bucket{${leLabel}le="${histogram.buckets[i]}"} ${histogram.counts[i]}`);
      }
      const infLabel = histogram.labelKey ? `{${histogram.labelKey}}` : '';
      lines.push(`${base}_bucket{${histogram.labelKey ? `${histogram.labelKey},` : ''}le="+Inf"} ${histogram.count}`);
      lines.push(`${base}_sum${infLabel} ${histogram.sum}`);
      lines.push(`${base}_count${infLabel} ${histogram.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
