/**
 * health の取得と、枠の ON/OFF（localStorage）。
 *
 * 枠の可否は providers[] だけで決める。トップレベルの available は見ない。
 * health の取得そのものが失敗したときだけ全枠を無効にする。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkHealth, type JudgeHealth, type JudgeProviderInfo } from './judge';
import {
  PROVIDER_IDS,
  type EnabledMap,
  type ProviderId,
  effectiveEnabled,
  loadEnabled,
  saveEnabled,
} from './providerPrefs';

export type HealthStatus = 'checking' | 'ready' | 'offline';

export function useProviderHealth() {
  const [status, setStatus] = useState<HealthStatus>('checking');
  const [health, setHealth] = useState<JudgeHealth | null>(null);
  const [saved, setSaved] = useState<EnabledMap>(() => loadEnabled());
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setStatus('checking');
    const found = await checkHealth();
    if (generationRef.current !== generation) return;

    if (found === null) {
      setHealth(null);
      setStatus('offline');
      return;
    }
    setHealth(found);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const available = useMemo(() => {
    if (status !== 'ready' || health === null) return null;
    const map: Record<ProviderId, boolean> = {
      typesafe: false,
      openai: false,
      gemini: false,
    };
    for (const item of health.providers) {
      if ((PROVIDER_IDS as readonly string[]).includes(item.id)) {
        map[item.id as ProviderId] = item.available;
      }
    }
    return map;
  }, [status, health]);

  const enabled = useMemo(
    () => effectiveEnabled(saved, available),
    [saved, available],
  );

  const setProviderEnabled = useCallback(
    (id: ProviderId, value: boolean) => {
      // available でない枠はトグルさせない（呼び出し側でも disabled にする）
      if (available === null || !available[id]) return;
      setSaved((current) => {
        const next = { ...current, [id]: value };
        saveEnabled(next);
        return next;
      });
    },
    [available],
  );

  const providerInfo = useCallback(
    (id: ProviderId): JudgeProviderInfo | undefined =>
      health?.providers.find((item) => item.id === id),
    [health],
  );

  const anyEnabled = PROVIDER_IDS.some((id) => enabled[id]);
  const canStart = status === 'ready' && anyEnabled;

  return {
    status,
    health,
    enabled,
    saved,
    available,
    setProviderEnabled,
    providerInfo,
    canStart,
    refresh,
  };
}
