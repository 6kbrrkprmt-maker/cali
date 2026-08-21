export interface WorkerSession {
  id: string;
  bridgeSessionId: string;
  platformUserId: string;
  launchUrl: string;
  liveKit?: {
    room: string;
    ingressId: string;
    ingressUrl: string;
    streamKey: string;
  };
  startedAt: string;
}
