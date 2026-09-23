/** 参加者の一覧。切断中の人も残す（会場には居るため） */
import type { PlayerView } from '../protocol';

type Props = {
  players: PlayerView[];
  buzzedId: string | null;
};

export function PlayerList({ players, buzzedId }: Props) {
  if (players.length === 0) {
    return <p className="player-list-empty">参加者を待っています…</p>;
  }

  return (
    <ul className="player-list">
      {players.map((player) => {
        const classNames = ['player-item'];
        if (player.id === buzzedId) classNames.push('buzzed');
        if (player.is_ai) classNames.push('ai');
        if (!player.connected) classNames.push('offline');
        if (player.locked_out) classNames.push('locked');

        return (
          <li key={player.id} className={classNames.join(' ')}>
            <span className="player-item-name">{player.name}</span>
            {player.is_ai && <span className="player-item-tag">AI</span>}
            {player.locked_out && <span className="player-item-tag">お手つき</span>}
            {!player.connected && <span className="player-item-tag">切断</span>}
          </li>
        );
      })}
    </ul>
  );
}
