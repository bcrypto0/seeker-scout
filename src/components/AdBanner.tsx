import React, { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { fetchBanners } from '../lib/catalog';
import { PromoBanner } from '../lib/types';
import { colors } from '../theme';

const ROTATE_MS = 4500;

/**
 * Auto-rotating promo carousel fed by the hosted banners.json — house promos
 * and ad slots rotate server-side, no app update needed. Renders nothing when
 * the feed is empty or unreachable.
 */
export function AdBanner() {
  const [banners, setBanners] = useState<PromoBanner[]>([]);
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList<PromoBanner>>(null);
  const { width } = useWindowDimensions();

  useEffect(() => {
    fetchBanners().then(setBanners);
  }, []);

  useEffect(() => {
    if (banners.length < 2) return;
    const t = setInterval(() => {
      setIndex((i) => {
        const next = (i + 1) % banners.length;
        listRef.current?.scrollToIndex({ index: next, animated: true });
        return next;
      });
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [banners.length]);

  if (!banners.length) return null;

  const open = (b: PromoBanner) => {
    const link = b.storePackage
      ? `solanadappstore://details?id=${b.storePackage}`
      : b.url;
    if (link) Linking.openURL(link).catch(() => {});
  };

  return (
    <View style={styles.wrap}>
      <FlatList
        ref={listRef}
        data={banners}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(b) => b.id}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={(e) =>
          setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.page, { width }]}
            onPress={() => open(item)}
          >
            <View
              style={[styles.card, item.color ? { borderColor: item.color } : null]}
            >
              <View style={styles.topRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title}
                </Text>
                {!!item.label && <Text style={styles.label}>{item.label}</Text>}
              </View>
              {!!item.tagline && (
                <Text style={styles.tagline} numberOfLines={2}>
                  {item.tagline}
                </Text>
              )}
            </View>
          </Pressable>
        )}
      />
      {banners.length > 1 && (
        <View style={styles.dots}>
          {banners.map((b, i) => (
            <View
              key={b.id}
              style={[styles.dot, i === index && styles.dotActive]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12 },
  page: { paddingHorizontal: 16 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.green,
    borderRadius: 14,
    padding: 14,
    minHeight: 84,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1 },
  label: {
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  tagline: { color: colors.textDim, marginTop: 6, fontSize: 12, lineHeight: 16 },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  dotActive: { backgroundColor: colors.green },
});
