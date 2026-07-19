import React from 'react';
import { View } from 'react-native';
import Svg, { Polyline, Circle } from 'react-native-svg';
import { colors } from '../theme';

/**
 * Tiny rank sparkline. Input is rankHistory (daily ranks, oldest→newest;
 * LOWER is better), so we invert Y. Raw react-native-svg Polyline — no chart
 * lib (battle plan §6.9). Renders nothing with <2 points.
 */
export function Sparkline({
  data,
  width = 96,
  height = 28,
}: {
  data?: number[];
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 3;
  const stepX = (width - pad * 2) / (data.length - 1);

  // Lower rank = better = higher on the chart → invert.
  const pts = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + ((v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1];
  // Trend colour: improved (rank went down) = green, worsened = red.
  const improved = data[data.length - 1] <= data[0];
  const stroke = improved ? colors.green : colors.red;

  return (
    <View>
      <Svg width={width} height={height}>
        <Polyline
          points={pts.map((p) => p.join(',')).join(' ')}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <Circle cx={last[0]} cy={last[1]} r={2.5} fill={stroke} />
      </Svg>
    </View>
  );
}
