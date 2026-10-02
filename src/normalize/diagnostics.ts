import type { DiagnosticLevel, NormalizedDiagnostic } from '../model/transaction.ts';

/**
 * Collects factual notes about a response while normalizing.
 *
 * A collector (rather than throwing) is deliberate: a missing optional field is
 * not a crash, it is *information* — we record it and keep the value `null`.
 */
export class DiagnosticCollector {
  private readonly items: NormalizedDiagnostic[] = [];

  add(level: DiagnosticLevel, code: string, message: string): void {
    this.items.push({ level, code, message });
  }

  info(code: string, message: string): void {
    this.add('info', code, message);
  }

  warn(code: string, message: string): void {
    this.add('warning', code, message);
  }

  /** Snapshot; the order diagnostics were added is itself deterministic. */
  collect(): readonly NormalizedDiagnostic[] {
    return this.items;
  }
}
