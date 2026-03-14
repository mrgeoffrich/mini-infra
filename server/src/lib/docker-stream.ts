/**
 * Docker multiplexed stream parsing.
 *
 * Docker multiplexes stdout and stderr into a single stream with 8-byte headers:
 *   [stream_type, 0, 0, 0, size1, size2, size3, size4]
 *   stream_type: 0=stdin, 1=stdout, 2=stderr
 *
 * DockerStreamDemuxer is a buffered parser that correctly handles chunks
 * containing multiple frames or partial frames split across chunks.
 */

export type DockerStreamType = "stdout" | "stderr" | "stdin";

export interface DockerStreamFrame {
  stream: DockerStreamType;
  data: Buffer;
}

const HEADER_SIZE = 8;

function streamTypeFromByte(byte: number): DockerStreamType {
  if (byte === 1) return "stdout";
  if (byte === 2) return "stderr";
  return "stdin";
}

/**
 * Buffered Docker stream demuxer that correctly handles partial frames.
 * Chunks may contain partial or multiple frames; this class buffers
 * incoming data and yields only complete frames.
 */
export class DockerStreamDemuxer {
  private buffer = Buffer.alloc(0);

  /**
   * Push a chunk of data and return any complete frames parsed from it.
   */
  push(chunk: Buffer): DockerStreamFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: DockerStreamFrame[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      const size = this.buffer.readUInt32BE(4);

      if (this.buffer.length < HEADER_SIZE + size) {
        break; // Incomplete frame, wait for more data
      }

      const stream = streamTypeFromByte(this.buffer.readUInt8(0));
      const data = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + size);
      this.buffer = this.buffer.subarray(HEADER_SIZE + size);

      frames.push({ stream, data });
    }

    return frames;
  }
}
