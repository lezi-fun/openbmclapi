export interface TrafficDelta {
  hits: number
  bytes: number
}

export type TrafficSnapshot = Readonly<TrafficDelta>

export interface TrafficRecorder {
  record(delta: TrafficDelta): void
}

export class TrafficMeter implements TrafficRecorder {
  private hits = 0
  private bytes = 0

  public record(delta: TrafficDelta): void {
    this.hits += delta.hits
    this.bytes += delta.bytes
  }

  public snapshot(): TrafficSnapshot {
    return {hits: this.hits, bytes: this.bytes}
  }

  public acknowledge(snapshot: TrafficSnapshot): void {
    this.hits -= snapshot.hits
    this.bytes -= snapshot.bytes
  }
}
