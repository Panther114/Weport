# Analytics word cloud integration

Import the DOM-based component where a future analytics view needs an accessible cloud:

```tsx
import { AnalyticsWordCloud } from '../../components/analytics/AnalyticsWordCloud'

<AnalyticsWordCloud
  words={wordFreq} // readonly { word: string; count: number }[]
  maxWords={48}
  onSelect={(item) => setSelectedWord(item.word)}
  selectedWord={selectedWord}
/>
```

`palette`, `minFontSize`, `maxFontSize`, `label`, `listLabel`, and `formatTooltip` are optional. The component sorts/deduplicates input deterministically, measures the responsive stage with `ResizeObserver`, and exposes a keyboard-operable fallback list. It does not require `echarts-wordcloud`; the current ECharts integrations remain unchanged until a page explicitly adopts this component.
