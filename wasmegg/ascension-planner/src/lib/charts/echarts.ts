/**
 * Central, tree-shaken echarts registration.
 *
 * Import `echarts` from here (never from the top-level `echarts` package) so every chart in this
 * app shares one registration call and one bundle-sized subset of components — pulling in
 * `echarts/core` + only the pieces below keeps the chart bundle to a fraction of the full
 * `echarts` package (which registers every chart type, including many this app never uses).
 */
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import type { LineSeriesOption, ScatterSeriesOption } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkPointComponent,
  MarkLineComponent,
  DataZoomComponent,
} from 'echarts/components';
import type {
  GridComponentOption,
  TooltipComponentOption,
  LegendComponentOption,
  DataZoomComponentOption,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ComposeOption } from 'echarts/core';

echarts.use([
  LineChart,
  // Added for the chain-search shape chart: thousands of priced chains as points, which a line
  // series cannot render without implying an order between them that does not exist.
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkPointComponent,
  MarkLineComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

export type ChartOption = ComposeOption<
  | LineSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | DataZoomComponentOption
>;

/** The series kinds this app registers, for components that build a series array by hand. */
export type ChartSeriesOption = LineSeriesOption | ScatterSeriesOption;

export { echarts };
export type { ECharts } from 'echarts/core';
