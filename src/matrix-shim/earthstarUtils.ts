import { EarthstarError, isErr } from '@earthstar/earthstar';

export function handleErr<T>(data: T | EarthstarError): T {
  if (isErr(data)) throw data;
  return data;
}
