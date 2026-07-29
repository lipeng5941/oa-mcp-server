import { callApi } from './client';
import { RoomSearchParams, Room, ApiResponse } from '../types/room';

export async function searchRoom(params: RoomSearchParams): Promise<ApiResponse<Room>> {
  const { roomnm, capacity, building, current = 1, size = 15 } = params;
  return await callApi('/SGSMTOAMGR/oa/room/list', { roomnm, capacity, building, current, size });
}

export async function getRoomDetail(roomid: string): Promise<Room> {
  return await callApi('/SGSMTOAMGR/oa/room/detail', { roomid });
}