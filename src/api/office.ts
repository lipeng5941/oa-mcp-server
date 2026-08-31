import { ServerConfig } from '../config';
import { VerifiedIdentity } from '../auth/verify';
import { callAdapter } from './adapter';
import { OfficeSearchParams } from '../types/office';

export async function searchOffice(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  params: OfficeSearchParams,
  reqId: string
): Promise<unknown> {
  const { officenm, address, current = 1, size = 15 } = params;
  return callAdapter(cfg, identity, 'office', 'list', { officenm, address, current, size }, reqId);
}

export async function getOfficeDetail(
  cfg: ServerConfig,
  identity: VerifiedIdentity,
  officeid: string,
  reqId: string
): Promise<unknown> {
  return callAdapter(cfg, identity, 'office', 'detail', { officeid }, reqId);
}
