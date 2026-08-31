import { ServerConfig } from '../config';
import { VerifiedIdentity } from '../auth/verify';
import { callAdapter } from './adapter';
import { RoomSearchParams } from '../types/room';

export async function searchRoom(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  params: RoomSearchParams,
  reqId: string
): Promise<unknown> {
  const { roomnm, capacity, building, current = 1, size = 15 } = params;
  return callAdapter(cfg, identity, 'meetroom', 'list', { roomnm, capacity, building, current, size }, reqId);
}

export async function getRoomDetail(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  roomid: string,
  reqId: string
): Promise<unknown> {
  return callAdapter(cfg, identity, 'meetroom', 'detail', { roomid }, reqId);
}
