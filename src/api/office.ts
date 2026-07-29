import { callApi } from './client';
import { OfficeSearchParams, Office, ApiResponse } from '../types/office';

export async function searchOffice(params: OfficeSearchParams): Promise<ApiResponse<Office>> {
  const { officenm, address, current = 1, size = 15 } = params;
  return await callApi('/SGSMTOAMGR/oa/office/list', { officenm, address, current, size });
}

export async function getOfficeDetail(officeid: string): Promise<Office> {
  return await callApi('/SGSMTOAMGR/oa/office/detail', { officeid });
}