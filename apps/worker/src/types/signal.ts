export type SignalKind = 'OFFER' | 'ANSWER' | 'ICE_CANDIDATE';
export type SignalFrom = 'CLIENT' | 'WORKER' | 'SYSTEM';

export interface WorkerSignal {
  id: number;
  from: SignalFrom;
  kind: SignalKind;
  payload: Record<string, unknown>;
  createdAt: string;
}
