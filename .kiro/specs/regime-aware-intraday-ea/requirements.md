# Requirements Document

## Introduction

本文档定义 MT5 平台日内自动交易 EA "Regime-Aware Intraday EA" 的功能需求。设计哲学为"识别复杂、策略极简":工程复杂度集中投入到市场状态识别(占比 ~50%),开仓动作使用经典极简方式(占比 ~15%),配合严格风控(占比 ~30%)与稳健执行(占比 ~5%)。

系统将传统二分类(趋势/震荡)升级为四态识别(TREND / RANGE / TRANSITION / CHAOS),通过五因子独立投票判定;在每态下使用极简子策略入场;以风险预算(而非笔数)作为主要限流手段;通过严格的回测门槛(真实 Tick + Walk-Forward + Monte Carlo)保证上线前可信度。

主跑品种为 EURUSD、GBPUSD、USDJPY、XAUUSD;识别周期 H1,执行周期 M15;不持仓过周末。

## Glossary

- **EA**:本系统在 MT5 平台运行的自动交易程序(Expert Advisor)。
- **Regime_Engine**:市场状态识别引擎,基于五因子投票输出当前 H1 状态(TREND / RANGE / TRANSITION / CHAOS)及置信度。
- **TREND**:趋势态(高置信),启用突破回踩子策略。
- **RANGE**:震荡态(高置信),启用 RANGE_3PUSH 与 RANGE_NORMAL 子策略。
- **TRANSITION**:过渡态(低置信),启用收紧参数的试探仓子策略。
- **CHAOS**:混沌态,禁止开新仓。
- **F1**:H1 周期 ADX(14),衡量方向强度。
- **F2**:ATR(14)/ATR(50) 比值,衡量短期相对长期波动率结构。
- **F3**:滚动 100 根 K 线 Hurst 指数,衡量序列自相似性。
- **F4**:Higher High & Higher Low 计数,衡量结构破坏。
- **F5**:最近 20 根 K 线 Range 加权方向值,衡量波动方向一致性。
- **Voting_Module**:汇总 F1–F5 投票并输出状态判定的子模块。
- **Hysteresis_Threshold**:滞回阈值,进入与离开同一状态阈值差不少于 3 个百分点缓冲,用于防止状态翻转。
- **Min_Hold_Bars**:状态确认后强制持续的最小 K 线数(TREND ≥5 根,RANGE ≥8 根)。
- **TREND_Strategy**:TREND 态下的突破回踩子策略。
- **RANGE_3PUSH_Strategy**:RANGE 态 A 级三推子策略。
- **RANGE_NORMAL_Strategy**:RANGE 态 B 级二次触碰子策略。
- **TRANSITION_Strategy**:TRANSITION 态 C 级试探子策略。
- **Range_Definition_Module**:基于 M15 过去 30 根 K 线计算 R_high、R_low、R_height 的子模块。
- **R_high**:M15 过去 30 根前 3 个高点的中位数。
- **R_low**:M15 过去 30 根前 3 个低点的中位数。
- **R_height**:R_high - R_low。
- **Touch_Counter**:区间边界触碰计数器,按规则识别独立触碰。
- **Range_Aging_Module**:区间老化保护子模块,触碰次数 ≥4 时切换到突破等待模式。
- **Risk_Engine**:风控引擎,负责仓位计算、风险预算、熔断与敞口管理。
- **Position_Sizer**:依据账户净值、风险系数、ATR 止损距离与每点价值计算手数的子模块。
- **Hard_Filter**:在任何信号通过前执行点差、时段、新闻、周末、节日过滤的子模块。
- **Execution_Engine**:执行层,负责挂单、滑点保护、重试、保护性止损与状态切换撤单。
- **Backtest_Module**:回测与验证子系统,执行 Tick 级回测、Walk-Forward 与 Monte Carlo。
- **Monitoring_Module**:实盘运行期间监控偏差与子策略表现并触发熔断/报警的子模块。
- **Config_Manager**:负责加载、校验、热重载外部参数文件的子模块。
- **Standard_Lot**:标准仓位,对应 0.5% 单笔风险。
- **Signal_Grade**:信号分级,A 级(RANGE_3PUSH 与 TREND 突破回踩)、B 级(RANGE_NORMAL)、C 级(TRANSITION)。
- **Daily_Risk_Budget**:单日累计已用风险上限(净值百分比)。
- **Spread_Avg**:该品种最近 N 根 K 线的平均点差。
- **Beijing_Time**:北京时间(UTC+8,固定不变)。Note: 伦敦盘和纽约盘的实际开盘时间会随英国/美国夏令时切换偏移 1 小时;Hard_Filter 应根据当前 DST 状态自动调整 London_Session_Window 和 NewYork_Session_Window 的 Beijing_Time 起止值,而非硬编码。
- **News_Window**:高重要度新闻前 30 分钟至后 15 分钟的禁开仓时段。
- **Walk_Forward_Analysis**:滚动样本内/样本外回测分析。
- **Monte_Carlo_Test**:对历史交易序列做 1000 次随机重采样的鲁棒性测试。
- **Strength_Vote**:F1、F2、F3 因子的输出值,取值集合为 {TREND, RANGE, NEUTRAL, UNAVAILABLE},仅表达"趋势/震荡强度"维度,不表达方向。
- **Direction_Vote**:F4、F5 因子的输出值,取值集合为 {TREND_UP, TREND_DOWN, RANGE, UNAVAILABLE},同时表达方向与趋势/震荡判断。
- **Ground_Truth_Regime**:回测中用于评价 Regime_Engine 准确率与召回率的真值标签,定义见 Requirement 11 Acceptance Criterion 6。
- **Aggregated_Account**:指 EA 管理的全部品种和子策略总体,不区分子账户;所有"aggregated"表述(包括 Daily_Risk_Budget、连败计数、浮盈回吐等)均按此范围计算。
- **R_Unit (1R)**:入场价到初始保护性止损的距离 × 当前仓位 = 该单的初始风险金额(账户币种计价)。Acceptance criteria 中所有"1R"、"0.3R"、"0.7R"等表述按此换算。
- **Reversal_Bar**:M15 K 线满足以下条件:在上沿触碰时,上影 > 实体 × 1.5(RANGE_NORMAL)或 × 2.0(TRANSITION);在下沿触碰时,下影 > 实体 × 1.5 / 2.0;实体 = |close − open|。
- **Keltner_Channel_Width**:KC_upper − KC_lower,其中 KC_upper = EMA(20) + 2 × ATR(14)、KC_lower = EMA(20) − 2 × ATR(14),均在 M15 周期。
- **EMA_Slope_Sign**:H1 周期 EMA(50) 的方向斜率符号,定义为 sign(EMA(50)[当前 K 线] − EMA(50)[5 根 K 线之前]),取值 {+1, 0, −1}。
- **Trading_Day**:从 Beijing_Time 当日 00:00 至次日 00:00。Daily_Risk_Budget、单日熔断、单日次数限制等"per day / 当日"表述的归零均按此边界。
- **Trading_Week**:从 Beijing_Time 周一 00:00 至下周一 00:00,覆盖伦敦/纽约的实际交易周。
- **Trading_Month**:按公历月份,Beijing_Time 时区。月度回撤熔断与子策略集中度告警均按此边界。

## Requirements

### Requirement 1: 因子 F1 ADX 计算

**User Story:** As a quant developer, I want F1 to provide a directional-strength signal on H1, so that the Regime_Engine can vote on trend strength.

#### Acceptance Criteria

1. THE Regime_Engine SHALL compute F1 as ADX with period 14 on the H1 timeframe for each configured symbol.
2. WHEN F1 value is greater than or equal to 25, THE Regime_Engine SHALL register F1 vote as TREND.
3. WHEN F1 value is less than or equal to 20, THE Regime_Engine SHALL register F1 vote as RANGE.
4. WHEN F1 value is greater than 20 and less than 25, THE Regime_Engine SHALL register F1 vote as NEUTRAL.
5. IF the H1 history is shorter than 28 bars on a given symbol, THEN THE Regime_Engine SHALL register F1 vote as UNAVAILABLE and SHALL NOT emit any regime decision for that symbol.

### Requirement 2: 因子 F2 ATR 结构

**User Story:** As a quant developer, I want F2 to measure short-term volatility relative to longer-term volatility, so that the Regime_Engine can detect volatility regime shifts.

#### Acceptance Criteria

1. THE Regime_Engine SHALL compute F2 as the ratio ATR(14) divided by ATR(50) on the H1 timeframe.
2. WHEN F2 is greater than or equal to 1.20, THE Regime_Engine SHALL register F2 vote as TREND.
3. WHEN F2 is less than or equal to 0.85, THE Regime_Engine SHALL register F2 vote as RANGE.
4. WHEN F2 is greater than 0.85 and less than 1.20, THE Regime_Engine SHALL register F2 vote as NEUTRAL.
5. IF the H1 history is shorter than 50 bars on a given symbol, THEN THE Regime_Engine SHALL register F2 vote as UNAVAILABLE.

### Requirement 3: 因子 F3 Hurst 指数

**User Story:** As a quant developer, I want F3 to estimate self-similarity of the price series, so that the Regime_Engine can detect persistence (trend) versus mean-reversion (range).

#### Acceptance Criteria

1. THE Regime_Engine SHALL compute F3 as the rolling Hurst exponent over the most recent 100 H1 bars per symbol.
2. WHEN F3 is greater than or equal to 0.55, THE Regime_Engine SHALL register F3 vote as TREND.
3. WHEN F3 is less than or equal to 0.45, THE Regime_Engine SHALL register F3 vote as RANGE.
4. WHEN F3 is greater than 0.45 and less than 0.55, THE Regime_Engine SHALL register F3 vote as NEUTRAL.
5. IF the H1 history is shorter than 100 bars on a given symbol, THEN THE Regime_Engine SHALL register F3 vote as UNAVAILABLE.

### Requirement 4: 因子 F4 Higher High & Higher Low 计数

**User Story:** As a quant developer, I want F4 to track structural make/break of swing highs and lows, so that the Regime_Engine can detect directional structure.

#### Acceptance Criteria

1. THE Regime_Engine SHALL count, over the most recent 20 H1 bars, the number of consecutive Higher Highs combined with Higher Lows for the bullish direction and Lower Highs combined with Lower Lows for the bearish direction.
2. WHEN the higher-high & higher-low count is greater than or equal to 4 in the bullish direction, THE Regime_Engine SHALL register F4 vote as TREND_UP.
3. WHEN the lower-high & lower-low count is greater than or equal to 4 in the bearish direction, THE Regime_Engine SHALL register F4 vote as TREND_DOWN.
4. WHEN neither directional structure count reaches 4 within the 20-bar window, THE Regime_Engine SHALL register F4 vote as RANGE.
5. IF the H1 history is shorter than 20 bars on a given symbol, THEN THE Regime_Engine SHALL register F4 vote as UNAVAILABLE.

### Requirement 5: 因子 F5 Range 加权方向

**User Story:** As a quant developer, I want F5 to express directional consistency weighted by bar range, so that the Regime_Engine can confirm directional momentum.

#### Acceptance Criteria

1. THE Regime_Engine SHALL compute F5 over the most recent 20 H1 bars as the sum of (sign(close - open) × (high - low)) divided by the sum of (high - low) for the same bars.
2. WHEN F5 is greater than or equal to 0.30, THE Regime_Engine SHALL register F5 vote as TREND_UP.
3. WHEN F5 is less than or equal to -0.30, THE Regime_Engine SHALL register F5 vote as TREND_DOWN.
4. WHEN F5 is greater than -0.30 and less than 0.30, THE Regime_Engine SHALL register F5 vote as RANGE.
5. IF the H1 history is shorter than 20 bars on a given symbol, THEN THE Regime_Engine SHALL register F5 vote as UNAVAILABLE.

### Requirement 6: 投票汇总与四态判定

**User Story:** As a quant developer, I want the Regime_Engine to convert F1–F5 votes into a four-state regime decision, so that downstream sub-strategies receive a single regime label per symbol.

#### Acceptance Criteria

1. WHEN at least 4 of the 5 factor votes agree on TREND (or TREND_UP / TREND_DOWN collectively), THE Regime_Engine SHALL classify the regime as TREND with confidence label HIGH.
2. WHEN at least 4 of the 5 factor votes agree on RANGE, THE Regime_Engine SHALL classify the regime as RANGE with confidence label HIGH.
3. WHEN exactly 3 of the 5 factor votes agree on the same direction (TREND or RANGE), THE Regime_Engine SHALL classify the regime as TRANSITION with confidence label LOW.
4. WHEN no more than 2 of the 5 factor votes agree on the same direction, THE Regime_Engine SHALL classify the regime as CHAOS.
5. IF any factor vote is UNAVAILABLE, THEN THE Regime_Engine SHALL exclude that vote from the count and SHALL require the same absolute thresholds (≥4 for HIGH, =3 for TRANSITION, ≤2 for CHAOS) on the remaining votes.
6. WHEN F4 vote and F5 vote indicate opposite directions (one TREND_UP and one TREND_DOWN), THE Regime_Engine SHALL classify the regime as CHAOS regardless of strength factor agreement.
7. WHEN classifying the regime as TREND with confidence label HIGH per Acceptance Criterion 1, THE Regime_Engine SHALL additionally require that, among F4 and F5 Direction_Votes that are not RANGE and not UNAVAILABLE, all such Direction_Votes agree on the same direction (both TREND_UP or both TREND_DOWN); IF this directional-agreement condition is not met, THEN THE Regime_Engine SHALL downgrade the classification to TRANSITION.

### Requirement 7: 滞回阈值与状态翻转保护

**User Story:** As a quant developer, I want hysteresis thresholds applied at regime entry and exit, so that the regime label does not oscillate around boundary values.

#### Acceptance Criteria

1. THE Regime_Engine SHALL apply a 3-percentage-point buffer between the entry threshold and the exit threshold for each factor's TREND/RANGE classification.
2. WHILE the current regime is TREND, THE Regime_Engine SHALL only transition out of TREND when the aggregated vote count for TREND falls below 3 (rather than 4).
3. WHILE the current regime is RANGE, THE Regime_Engine SHALL only transition out of RANGE when the aggregated vote count for RANGE falls below 3 (rather than 4).
4. THE Regime_Engine SHALL ensure that the per-bar regime switch probability, measured over any rolling 200 H1 bars, is less than 15%.
5. THE Regime_Engine SHALL apply the following precedence among regime-state rules: (1) CHAOS forced conditions per Requirement 23 always override all other rules; (2) Min_Hold_Bars per Requirement 8 overrides hysteresis per Requirement 7 within the min-hold window; (3) hysteresis per Requirement 7 governs all other transitions.

### Requirement 8: 最小持续时间约束

**User Story:** As a trader, I want a confirmed regime to persist for a minimum number of bars, so that fleeting signals do not trigger sub-strategies.

#### Acceptance Criteria

1. WHEN the Regime_Engine first classifies the regime as TREND, THE Regime_Engine SHALL hold the TREND label for at least 5 consecutive H1 bars regardless of intermediate vote changes, except when Requirement 23 forces CHAOS.
2. WHEN the Regime_Engine first classifies the regime as RANGE, THE Regime_Engine SHALL hold the RANGE label for at least 8 consecutive H1 bars regardless of intermediate vote changes, except when Requirement 23 forces CHAOS.
3. WHILE the minimum-hold window is active, THE Regime_Engine SHALL still publish the underlying vote counts for monitoring purposes.

### Requirement 9: 每品种独立识别

**User Story:** As a trader, I want each symbol's regime to be computed independently, so that one symbol's regime cannot bias another.

#### Acceptance Criteria

1. THE Regime_Engine SHALL maintain an independent factor history, voting state, hysteresis state, and minimum-hold counter for each configured symbol.
2. THE Regime_Engine SHALL NOT use any other symbol's data when computing F1–F5 or the regime label for a given symbol.
3. WHERE a new symbol is added to the configuration, THE Regime_Engine SHALL initialize that symbol's regime state independently and SHALL emit no regime decision until the longest factor lookback (100 H1 bars) is satisfied.

### Requirement 10: 亚洲盘 RANGE 信号置信折扣

**User Story:** As a trader, I want RANGE signals during the Asian session to be discounted, so that false-range patterns common in Asia are filtered.

#### Acceptance Criteria

1. WHILE the current Beijing_Time is between 14:00 and 15:00 (the late-Asian-session bridge to London open), THE Regime_Engine SHALL multiply the RANGE confidence score by a factor of 0.7 before publishing.
2. WHEN the discounted RANGE confidence score falls below the threshold required for HIGH confidence, THE Regime_Engine SHALL relabel the regime as TRANSITION for that bar.
3. THE Regime_Engine SHALL NOT apply the Asian-session discount to TREND, TRANSITION, or CHAOS classifications.

### Requirement 11: 识别引擎质量指标

**User Story:** As a trader, I want measurable quality metrics on the Regime_Engine, so that recognition quality can be validated against targets.

#### Acceptance Criteria

1. THE Backtest_Module SHALL compute Regime_Engine accuracy as the proportion of bars labeled TREND or RANGE that are followed by realized continuation of that regime over the next 5 H1 bars.
2. THE Backtest_Module SHALL compute Regime_Engine recall as the proportion of true regime windows in which at least 60% of bars are correctly labeled.
3. THE Backtest_Module SHALL compute the regime switching lag as the number of H1 bars between true regime onset and Regime_Engine label change, and SHALL flag any symbol whose median lag exceeds 3 H1 bars.
4. THE Backtest_Module SHALL flag the Regime_Engine as failing acceptance WHEN accuracy is below 75%, OR recall is below 60%, OR per-bar switch probability is at or above 15%, OR median switching lag exceeds 3 bars.
5. WHEN thresholds calibrated on EURUSD are applied without modification to GBPUSD or XAUUSD, THE Backtest_Module SHALL require accuracy on those symbols to remain above 70% and SHALL flag a calibration failure otherwise.
6. THE Backtest_Module SHALL define ground-truth regime windows as follows: a window of N consecutive H1 bars SHALL be labeled TREND IF at least 70% of the bars exhibit close-to-close moves in the same direction AND the cumulative directional move exceeds 1.5 × ATR(14) on H1; a window SHALL be labeled RANGE IF the cumulative directional move is less than 0.6 × ATR(14) on H1 AND no single bar's range exceeds 1.5 × ATR(14) on H1; the minimum window length N SHALL be 10 H1 bars.

### Requirement 12: TREND 子策略 — 突破识别与入场前置条件

**User Story:** As a trader, I want clear conditions to identify a tradeable breakout in TREND regime, so that entries are restricted to high-quality setups.

#### Acceptance Criteria

1. WHILE the H1 regime is TREND with HIGH confidence and the regime has held for at least 5 consecutive H1 bars, THE TREND_Strategy SHALL evaluate breakout conditions on M15 closes.
2. WHEN the M15 close exceeds the highest high of the previous 20 M15 bars (for long) or falls below the lowest low of the previous 20 M15 bars (for short), THE TREND_Strategy SHALL register a breakout candidate.
3. WHEN the breakout M15 bar's body length is greater than 0.6 × ATR(14) on M15, THE TREND_Strategy SHALL keep the candidate active; IF the body length is less than or equal to 0.6 × ATR(14) on M15, THEN THE TREND_Strategy SHALL discard the candidate.
4. WHEN the breakout M15 bar's close distance from the breakout level is less than 1.0 × ATR(14) on M15, THE TREND_Strategy SHALL keep the candidate active; IF the close distance is greater than or equal to 1.0 × ATR(14) on M15, THEN THE TREND_Strategy SHALL discard the candidate to avoid late entries.
5. THE TREND_Strategy SHALL require the H1 EMA(50) slope sign — defined as sign(EMA(50)[current bar] − EMA(50)[5 bars ago]) — to match the candidate direction; IF the slope sign is opposite or zero, THEN THE TREND_Strategy SHALL discard the candidate.

### Requirement 13: TREND 子策略 — 回踩入场与挂单超时

**User Story:** As a trader, I want pullback-based limit entries with timeout, so that I do not chase price.

#### Acceptance Criteria

1. WHEN a breakout candidate is active, THE TREND_Strategy SHALL place a limit order at the breakout level offset by 0.3 × ATR(14) on M15 in the pullback direction.
2. THE TREND_Strategy SHALL set the limit order's maximum allowed slippage to 3 points and SHALL set the limit order's expiration to 3 M15 bars.
3. IF price has not retraced into the [breakout_level - 0.3 ATR, breakout_level + 0.3 ATR] band within 6 M15 bars after the breakout, THEN THE TREND_Strategy SHALL cancel the limit order and SHALL discard the candidate.
4. WHEN the limit order is submitted, THE TREND_Strategy SHALL include the protective stop-loss as part of the same MT5 OrderSendStruct (using the SL field) so that fill and stop-loss are atomic at the broker; THE Execution_Engine SHALL verify SL presence after fill confirmation per Requirement 36.

### Requirement 14: TREND 子策略 — 止损止盈、保本与时间止损

**User Story:** As a trader, I want defined stop, partial-profit, breakeven and time-stop rules, so that trades are managed mechanically.

#### Acceptance Criteria

1. WHEN a TREND_Strategy position is opened, THE TREND_Strategy SHALL set the protective stop-loss at the breakout level offset by 1.5 × ATR(14) on M15 against the trade direction.
2. WHEN unrealized profit reaches 1R (one risk unit) on a TREND_Strategy position, THE TREND_Strategy SHALL close 50% of the position at market.
3. WHEN the first partial profit is taken, THE TREND_Strategy SHALL move the remaining position's stop to the entry price offset by 0.2 × ATR(14) on M15 in the profit direction.
4. THE TREND_Strategy SHALL trail the remaining position using a Chandelier Exit defined as the highest high (long) or lowest low (short) of the last 22 M15 bars offset by 3 × ATR(14) on M15.
5. IF a TREND_Strategy position has not reached its first 1R target within 24 hours of entry AND the position is in unrealized loss exceeding 0.3R, THEN THE TREND_Strategy SHALL close the entire position at market. IF the position is at or near breakeven (between −0.3R and +1R) after 24 hours, THE TREND_Strategy SHALL continue managing the position under the trailing-stop logic of Acceptance Criterion 4 until the trailing stop or a time-stop of 48 hours from entry triggers.
6. THE TREND_Strategy SHALL size each entry at 100% of Standard_Lot, equivalent to 0.5% account risk per trade.

### Requirement 15: RANGE 区间定义与有效性

**User Story:** As a trader, I want a precise definition of the trading range, so that touches and entries are objective.

#### Acceptance Criteria

1. THE Range_Definition_Module SHALL compute R_high as the median of the top 3 highs over the most recent 30 M15 bars per symbol.
2. THE Range_Definition_Module SHALL compute R_low as the median of the bottom 3 lows over the most recent 30 M15 bars per symbol.
3. THE Range_Definition_Module SHALL compute R_height as R_high minus R_low.
4. WHEN R_height is less than 0.6 × ATR(14) on D1, THE Range_Definition_Module SHALL mark the range as VALID.
5. IF R_height is greater than or equal to 0.6 × ATR(14) on D1, THEN THE Range_Definition_Module SHALL mark the range as INVALID and SHALL block all RANGE sub-strategy entries on that symbol.

### Requirement 16: 区间触碰计数规则

**User Story:** As a trader, I want strict, independent touch counting, so that the 3-push pattern is unambiguous.

#### Acceptance Criteria

1. WHEN an M15 bar's high is greater than or equal to (R_high - 0.2 × ATR(14) on M15) and the bar's close is less than R_high, THE Touch_Counter SHALL register an upper-edge touch.
2. WHEN an M15 bar's low is less than or equal to (R_low + 0.2 × ATR(14) on M15) and the bar's close is greater than R_low, THE Touch_Counter SHALL register a lower-edge touch.
3. THE Touch_Counter SHALL only count two consecutive same-edge touches as independent IF either (a) price has returned to within ±0.3 × ATR(14) on M15 of the range midline between the two touches, OR (b) at least 8 M15 bars have elapsed between the two touches.
4. WHEN the range becomes INVALID per Requirement 15, THE Touch_Counter SHALL reset all touch counts for that symbol's range to zero.

### Requirement 17: RANGE_3PUSH (A 级) 入场条件

**User Story:** As a trader, I want a high-EV third-touch reversal entry with strict filters, so that A-grade signals are rare but reliable.

#### Acceptance Criteria

1. WHEN the Touch_Counter registers the third independent touch on the same edge of a VALID range, THE RANGE_3PUSH_Strategy SHALL evaluate the entry conditions in this requirement.
2. THE RANGE_3PUSH_Strategy SHALL require R_height to be within [0.4 × ATR(14) on D1, 0.8 × ATR(14) on D1].
3. THE RANGE_3PUSH_Strategy SHALL require the touching M15 bar to be a reversal bar whose upper or lower wick is greater than 1.5 times the bar body length, on the side of the touched edge.
4. WHERE RSI(14) on M15 fails to make a new extreme on the third touch compared with the second touch (bearish divergence at upper edge or bullish divergence at lower edge), THE RANGE_3PUSH_Strategy SHALL increase the signal score; IF this divergence is absent, THEN THE RANGE_3PUSH_Strategy SHALL still allow entry but SHALL log the signal as "no-divergence".
5. THE RANGE_3PUSH_Strategy SHALL only accept entries during the London session (Beijing_Time 15:00–19:00) or the New York session (Beijing_Time 21:30–23:30).
6. THE RANGE_3PUSH_Strategy SHALL require the current price to be within 0.3 × ATR(14) on M15 of the touched edge at order submission time.
7. THE RANGE_3PUSH_Strategy SHALL require ADX(14) on M15 to be less than 22 OR less than ADX(14) on H1 minus 5, whichever is more permissive; this dual condition SHALL be re-validated at every order-submission attempt.
8. THE RANGE_3PUSH_Strategy SHALL require the current spread to be less than 1.5 × Spread_Avg for the symbol.

### Requirement 18: RANGE_3PUSH (A 级) 出场、保本与仓位

**User Story:** As a trader, I want defined two-stage profit-taking, breakeven, time-stop and oversized sizing for A-grade signals, so that the highest-quality signals get the most capital.

#### Acceptance Criteria

1. WHEN a RANGE_3PUSH_Strategy entry is filled, THE RANGE_3PUSH_Strategy SHALL place a market order and submit a protective stop-loss at the touched edge offset by 0.8 × ATR(14) on M15 outside the range.
2. WHEN price reaches the range midline, THE RANGE_3PUSH_Strategy SHALL close 60% of the position.
3. WHEN price reaches the 70% level of the opposite range edge after the first partial profit, THE RANGE_3PUSH_Strategy SHALL close the remaining position.
4. WHEN unrealized profit reaches 0.7R, THE RANGE_3PUSH_Strategy SHALL move the stop on the remaining position to the entry price.
5. IF a RANGE_3PUSH_Strategy position has not reached its first target within 6 M15 bars, THEN THE RANGE_3PUSH_Strategy SHALL close the entire position at market.
6. THE RANGE_3PUSH_Strategy SHALL size each entry at 120% of Standard_Lot, equivalent to 0.6% account risk per trade.
7. THE RANGE_3PUSH_Strategy SHALL be classified as Signal_Grade A and SHALL NOT be limited by daily entry count.

### Requirement 19: RANGE_3PUSH 取消与转向信号

**User Story:** As a trader, I want explicit cancel and regime-switch signals around third-touch entries, so that I exit failed setups fast.

#### Acceptance Criteria

1. IF, on the M15 bar immediately following a registered third touch, price still trades within 0.3 × ATR(14) on M15 of the touched edge, THEN THE RANGE_3PUSH_Strategy SHALL cancel any pending entry order or close any just-filled position at market.
2. WHEN an M15 bar closes beyond the opposite range edge against an existing RANGE_3PUSH position, THE RANGE_3PUSH_Strategy SHALL close the entire remaining position at market and SHALL NOT directly transfer the position to TREND_Strategy.
3. WHEN a RANGE_3PUSH position has been forcibly closed per Acceptance Criterion 2, THE TREND_Strategy SHALL be permitted to evaluate a new entry under Requirements 12–14 only after the next M15 bar close confirms the breakout direction.

### Requirement 20: RANGE_NORMAL (B 级) 入场与出场

**User Story:** As a trader, I want a B-grade second-touch range fade with looser conditions but smaller size and daily cap, so that the system trades more frequently in normal ranges without overexposing capital.

#### Acceptance Criteria

1. WHEN the Touch_Counter registers the second independent touch on the same edge of a VALID range, THE RANGE_NORMAL_Strategy SHALL evaluate entry conditions identical to Requirement 17 except that RSI divergence is not required.
2. WHEN a RANGE_NORMAL_Strategy entry is filled, THE RANGE_NORMAL_Strategy SHALL place a protective stop-loss at the touched edge offset by 0.5 × ATR(14) on M15 outside the range.
3. WHEN price reaches EMA(20) on M15, THE RANGE_NORMAL_Strategy SHALL close 70% of the position.
4. WHEN price reaches an opposite excursion equal to 0.5 × the current Keltner Channel width on M15, THE RANGE_NORMAL_Strategy SHALL close the remaining position.
5. THE RANGE_NORMAL_Strategy SHALL size each entry at 70% of Standard_Lot.
6. THE RANGE_NORMAL_Strategy SHALL be classified as Signal_Grade B and SHALL be limited to no more than 5 entries per calendar day across all symbols.
7. WHERE the symbol is XAUUSD, THE RANGE_NORMAL_Strategy SHALL further multiply the position size by 0.7, resulting in 49% of Standard_Lot.

### Requirement 21: 区间老化保护

**User Story:** As a trader, I want aged ranges to switch from fade to breakout-wait, so that the system does not keep fading a range that is about to break.

#### Acceptance Criteria

1. WHEN the Touch_Counter for a given range reaches 4 or more on either edge, THE Range_Aging_Module SHALL mark that range as AGED.
2. WHILE a range is AGED, THE RANGE_3PUSH_Strategy and RANGE_NORMAL_Strategy SHALL NOT submit new entries.
3. WHILE a range is AGED, THE Range_Aging_Module SHALL place a buy-stop order at R_high + 0.3 × ATR(14) on M15 and a sell-stop order at R_low - 0.3 × ATR(14) on M15.
4. WHEN either Aged-Range stop order is filled, THE Range_Aging_Module SHALL manage the resulting position using the following parameters: protective stop at the opposite range edge offset by 1.0 × ATR(14) on M15, first partial-profit at 1R closing 50%, breakeven move on the remaining position when 1R is reached, and time-stop of 24 hours; THE Range_Aging_Module SHALL NOT require H1 TREND regime confirmation for these orders.
5. WHEN the range is recomputed and becomes INVALID per Requirement 15, THE Range_Aging_Module SHALL cancel both stop orders.

### Requirement 22: TRANSITION 试探仓子策略

**User Story:** As a trader, I want a small probing trade in TRANSITION regime with tightened parameters, so that low-confidence opportunities can still be tested with minimal risk.

#### Acceptance Criteria

1. WHILE the regime is TRANSITION, THE TRANSITION_Strategy SHALL select the dominant direction implied by the majority factor votes.
2. THE TRANSITION_Strategy SHALL apply the active sub-strategy's entry rules (TREND_Strategy or RANGE_NORMAL_Strategy) with the following parameter overrides: breakout body threshold raised from 0.6 × ATR(14) on M15 to 0.8 × ATR(14) on M15, reversal-bar wick-to-body ratio raised from 1.5 to 2.0, and ATR stop-loss multiplier reduced from 1.5 to 1.0.
3. THE TRANSITION_Strategy SHALL size each entry at 30% of Standard_Lot, equivalent to 0.15% account risk per trade.
4. THE TRANSITION_Strategy SHALL be classified as Signal_Grade C and SHALL be limited to no more than 1 entry per calendar day across all symbols.
5. WHERE the deployment phase is within the first 3 calendar months from go-live, THE TRANSITION_Strategy SHALL remain disabled and SHALL submit no entries regardless of regime votes.

### Requirement 23: CHAOS 态处理

**User Story:** As a trader, I want CHAOS regime to halt new entries and tighten existing ones, so that capital is protected during disorderly markets.

#### Acceptance Criteria

1. WHILE the regime is CHAOS, THE Regime_Engine SHALL block all sub-strategies from submitting new entries.
2. WHEN ATR(14) on M15 exceeds 2.5 × ATR(50) on M15 for any symbol, THE Regime_Engine SHALL force-classify that symbol's regime as CHAOS regardless of factor votes.
3. WHEN the current spread exceeds 2.0 × Spread_Avg for any symbol, THE Regime_Engine SHALL force-classify that symbol's regime as CHAOS regardless of factor votes.
4. WHILE CHAOS is active and existing positions are open, THE Execution_Engine SHALL tighten any active trailing stop by 50% of its current distance and SHALL block any pyramiding or scaling-in.

### Requirement 24: 信号分级与每日次数限制

**User Story:** As a trader, I want signal grades to drive daily caps, so that high-EV signals are unlimited while lower-EV signals are throttled.

#### Acceptance Criteria

1. THE Risk_Engine SHALL classify TREND_Strategy and RANGE_3PUSH_Strategy entries as Signal_Grade A.
2. THE Risk_Engine SHALL classify RANGE_NORMAL_Strategy entries as Signal_Grade B.
3. THE Risk_Engine SHALL classify TRANSITION_Strategy entries as Signal_Grade C.
4. THE Risk_Engine SHALL impose no per-day count limit on Signal_Grade A entries.
5. THE Risk_Engine SHALL allow no more than 5 Signal_Grade B entries per calendar day across all symbols combined.
6. THE Risk_Engine SHALL allow no more than 1 Signal_Grade C entry per calendar day across all symbols combined.
7. WHEN both the daily count limit per signal grade (this Requirement 24) and a symbol-specific risk pool (Requirement 30) apply to the same candidate entry, THE Risk_Engine SHALL block the new entry that would violate either constraint, taking the more restrictive of the two.
8. WHEN Signal_Grade A entries reach 8 in a single calendar day, THE Monitoring_Module SHALL emit a high-frequency-A-grade warning; THE Risk_Engine SHALL NOT block further A-grade entries unless Daily_Risk_Budget (Requirement 25) or another hard limit has been hit.

### Requirement 25: 单笔风险与单日风险预算

**User Story:** As a trader, I want per-trade and per-day risk budgets in account-equity percentage, so that risk is throttled by exposure rather than trade count.

#### Acceptance Criteria

1. THE Risk_Engine SHALL set the per-trade risk to 0.6% of account equity for Signal_Grade A entries.
2. THE Risk_Engine SHALL set the per-trade risk to 0.5% of account equity for Signal_Grade B entries.
3. THE Risk_Engine SHALL set the per-trade risk to 0.15% of account equity for Signal_Grade C entries.
4. THE Risk_Engine SHALL track Daily_Risk_Budget as the sum, across all positions opened during the current trading day, of the maximum of (a) the realized loss for closed positions (zero for closed-with-profit), and (b) the current remaining stop-loss-distance risk for open positions (zero if the remaining stop is at or beyond breakeven). Profitable closed trades SHALL NOT consume Daily_Risk_Budget.
5. WHEN Daily_Risk_Budget reaches 2.5% of account equity, THE Risk_Engine SHALL block all further entries until the next trading day.

### Requirement 26: 单日亏损熔断与浮盈回吐保护

**User Story:** As a trader, I want hard daily loss and profit-giveback circuit breakers, so that one bad day cannot escalate.

#### Acceptance Criteria

1. WHEN realized plus unrealized intraday loss reaches 3.0% of starting-of-day account equity, THE Risk_Engine SHALL close all open positions at market and SHALL block all new entries until the next trading day.
2. WHILE intraday floating profit is positive, THE Risk_Engine SHALL track the intraday peak floating profit per symbol and aggregated.
3. WHEN intraday peak floating profit is greater than or equal to 1.0% of starting-of-day account equity AND aggregated floating profit retraces by 60% or more from the intraday peak, THE Risk_Engine SHALL close all open positions at market and SHALL block all new entries until the next trading day.
4. IF intraday peak floating profit is less than 1.0% of starting-of-day account equity, THEN THE Risk_Engine SHALL NOT activate the giveback monitor regardless of retracement percentage.

### Requirement 27: 周与月回撤熔断

**User Story:** As a trader, I want weekly and monthly drawdown breakers, so that compounding losses force a hard stop and review.

#### Acceptance Criteria

1. WHEN week-to-date drawdown from the weekly starting equity reaches 6.0%, THE Risk_Engine SHALL block all new entries until the start of the following trading week.
2. WHEN month-to-date drawdown from the monthly starting equity reaches 10.0%, THE Risk_Engine SHALL block all new entries and SHALL emit a "manual review required" alert until the operator explicitly re-enables trading.

### Requirement 28: 连败暂停与偏差监控

**User Story:** As a trader, I want consecutive-loss and live-vs-backtest deviation monitors, so that the system pauses when its edge appears broken.

#### Acceptance Criteria

1. WHEN 4 consecutive losing trades occur across all symbols and sub-strategies, THE Risk_Engine SHALL block all new entries for 12 hours.
2. WHEN at least 50 closed trades have accumulated in live trading AND the live rolling Sharpe ratio over the most recent 30 closed trades falls below 50% of the backtest Sharpe ratio for the same configuration, THE Monitoring_Module SHALL block all new entries and SHALL emit a deviation alert. WHILE fewer than 50 closed trades have accumulated, THE Monitoring_Module SHALL log the rolling Sharpe but SHALL NOT trigger blocking.
3. WHEN a global consecutive-loss pause expires, THE Risk_Engine SHALL reset the global consecutive-loss counter to zero.

### Requirement 29: 持仓敞口与相关性管理

**User Story:** As a trader, I want concurrent-position and correlation rules, so that exposure does not concentrate.

#### Acceptance Criteria

1. THE Risk_Engine SHALL allow no more than 3 simultaneously open positions across all symbols.
2. WHEN EURUSD and GBPUSD have open positions in the same direction, THE Risk_Engine SHALL count them as 1 position slot toward the 3-position limit.
3. WHEN EURUSD and GBPUSD have open positions in opposite directions, THE Risk_Engine SHALL count each as an independent position slot.
4. THE Risk_Engine SHALL always count XAUUSD positions as independent slots from any FX position.
5. THE Risk_Engine SHALL ensure that the sum of risk on all simultaneously open positions does not exceed 1.5% of account equity.

### Requirement 30: 品种风险池

**User Story:** As a trader, I want each symbol to have a risk-pool allocation, so that no single symbol consumes the daily budget alone.

#### Acceptance Criteria

1. THE Risk_Engine SHALL allocate 30% of Daily_Risk_Budget to EURUSD.
2. THE Risk_Engine SHALL allocate 25% of Daily_Risk_Budget to GBPUSD with same-direction GBPUSD-EURUSD exposure consolidated per Requirement 29.
3. THE Risk_Engine SHALL allocate 20% of Daily_Risk_Budget to USDJPY.
4. THE Risk_Engine SHALL allocate 25% of Daily_Risk_Budget to XAUUSD as an independent pool.
5. WHEN a symbol's pool is exhausted within the day, THE Risk_Engine SHALL block new entries on that symbol until the next trading day even if the global Daily_Risk_Budget has remaining capacity.
6. THE per-symbol risk pool SHALL be a hard ceiling that cannot be bypassed by remaining global Daily_Risk_Budget capacity, and the global Daily_Risk_Budget SHALL be a hard ceiling that cannot be bypassed by remaining per-symbol pool capacity.

### Requirement 31: 子策略熔断

**User Story:** As a trader, I want per-sub-strategy circuit breakers and concentration alerts, so that a single sub-strategy cannot dominate or bleed unchecked.

#### Acceptance Criteria

1. WHEN a single sub-strategy accounts for more than 70% of the total trade count for the current calendar month, THE Monitoring_Module SHALL emit a concentration alert.
2. WHEN a single sub-strategy records 6 consecutive losing trades, THE Risk_Engine SHALL pause that sub-strategy for 48 hours.
3. WHEN a single sub-strategy's month-to-date drawdown exceeds 8% of monthly starting equity attributable to that sub-strategy, THE Risk_Engine SHALL pause that sub-strategy for 1 calendar week and SHALL emit a "manual review required" alert.
4. WHEN a per-sub-strategy consecutive-loss pause expires, THE Risk_Engine SHALL reset that sub-strategy's consecutive-loss counter to zero, while leaving the global counter (Requirement 28) unchanged unless it has independently expired.
5. THE per-sub-strategy consecutive-loss counter (Acceptance Criterion 2) SHALL count only that sub-strategy's losses; THE global consecutive-loss counter (Requirement 28 Acceptance Criterion 1) SHALL count losses across all sub-strategies and reset independently.

### Requirement 32: 硬过滤层 — 点差与时段

**User Story:** As a trader, I want spread and session filters before any signal is acted upon, so that hostile execution conditions are excluded.

#### Acceptance Criteria

1. WHEN the current spread for a symbol is greater than or equal to 1.5 × Spread_Avg for that symbol, THE Hard_Filter SHALL block all new entries on that symbol.
2. THE Hard_Filter SHALL only allow new entries during Beijing_Time 15:00–19:00 (London session) and Beijing_Time 21:30–23:30 (New York session).
3. THE Hard_Filter SHALL block all new entries outside the time windows defined in Acceptance Criterion 2.
4. THE Hard_Filter SHALL automatically adjust London session and New York session windows for daylight saving time transitions in their respective home jurisdictions, maintaining alignment with the actual market open and close times.
5. WHERE the symbol is USDJPY, THE Hard_Filter SHALL additionally allow new entries during Beijing_Time 14:00–15:00 (early-London / late-Asia bridge) where USDJPY liquidity is high and spreads are typically narrow.

### Requirement 33: 硬过滤层 — 新闻、周末与节日

**User Story:** As a trader, I want news, weekend and holiday filters, so that the EA does not trade across high-impact events or rollover gaps.

#### Acceptance Criteria

1. THE Hard_Filter SHALL block all new entries during the News_Window of any high-importance scheduled news release affecting any open symbol.
2. WHEN the current Beijing_Time is later than Friday 22:00, THE Hard_Filter SHALL block all new entries until the next London session of the following week.
3. THE Hard_Filter SHALL block all new entries during the 3 calendar days immediately before and after Christmas Day (December 25, Beijing_Time) and New Year's Day (January 1, Beijing_Time); the EA operator MAY extend this list via Config_Manager (Requirement 41) to include additional holidays such as Thanksgiving (4th Thursday of November) or major Chinese holidays.
4. WHILE a position is open and Friday 23:30 Beijing_Time is reached, THE Execution_Engine SHALL close that position at market.
5. WHILE the current Beijing_Time is later than Friday 21:30 AND any sub-strategy whose typical hold time exceeds 90 minutes evaluates an entry, THE Hard_Filter SHALL block that entry.

### Requirement 34: 仓位计算公式

**User Story:** As a trader, I want a single, deterministic sizing formula normalized by ATR per symbol, so that risk per trade is consistent.

#### Acceptance Criteria

1. THE Position_Sizer SHALL compute per-trade risk amount as account_equity × risk_factor, where risk_factor is 0.6% for Grade A, 0.5% for Grade B, and 0.15% for Grade C.
2. THE Position_Sizer SHALL compute stop-loss distance as ATR(14) on M15 × k, where k = 1.5 for FX symbols and k = 2.0 for XAUUSD.
3. THE Position_Sizer SHALL compute lot size as per-trade risk amount divided by (stop-loss distance × value-per-point for the symbol).
4. THE Position_Sizer SHALL round the resulting lot size down to the broker's minimum lot increment and SHALL reject the entry IF the rounded lot size is below the broker's minimum lot.

### Requirement 35: 执行层 — 点差与滑点保护

**User Story:** As a trader, I want runtime spread and slippage guards, so that bad fills are avoided.

#### Acceptance Criteria

1. THE Execution_Engine SHALL re-check the live spread against Requirement 32 immediately before submitting any order and SHALL abort the submission IF the spread is no longer compliant.
2. THE Execution_Engine SHALL set the maximum allowed slippage to 3 points on every order submission and SHALL abort the fill IF the broker reports a slippage greater than 3 points.

### Requirement 36: 执行层 — 订单可靠性与保护性止损

**User Story:** As a trader, I want order retries and immediate protective stops, so that infrastructure failures do not leave naked positions.

#### Acceptance Criteria

1. IF an order submission fails due to a transient broker error, THEN THE Execution_Engine SHALL retry the submission up to 2 additional times before giving up.
2. WHEN a position is opened, THE Execution_Engine SHALL submit the protective stop-loss order to the broker within 1 second of fill confirmation.
3. IF the protective stop-loss submission fails after retries, THEN THE Execution_Engine SHALL close the just-opened position at market.

### Requirement 37: 执行层 — 状态切换撤单

**User Story:** As a trader, I want pending orders cancelled when the regime changes, so that stale orders do not fire under wrong conditions.

#### Acceptance Criteria

1. WHEN the Regime_Engine changes the regime label for a symbol, THE Execution_Engine SHALL cancel all pending orders on that symbol that were submitted under the previous regime.
2. THE Execution_Engine SHALL NOT close existing filled positions solely due to a regime change, except as required by Requirements 23, 26, 27, 28 or 33.

### Requirement 38: 回测数据与方法

**User Story:** As a trader, I want professional-grade backtesting, so that performance estimates are credible.

#### Acceptance Criteria

1. THE Backtest_Module SHALL use real broker tick data covering at least 5 calendar years per symbol, supplemented by at least 10 calendar years of M1 OHLC bars when tick data is unavailable for the earlier period; THE Backtest_Module SHALL clearly distinguish tick-based and bar-based segments in its report.
2. THE Backtest_Module SHALL run Walk_Forward_Analysis with at least 5 rolling in-sample / out-of-sample windows per symbol.
3. THE Backtest_Module SHALL run Monte_Carlo_Test with at least 1000 random resamples of the trade sequence per symbol.
4. THE Backtest_Module SHALL produce a written report containing per-symbol Sharpe ratio, maximum drawdown, win rate, profit factor, monthly trade count and Regime_Engine quality metrics from Requirement 11.

### Requirement 39: 上线门槛

**User Story:** As a trader, I want explicit go-live gates, so that no version reaches live trading without meeting them.

#### Acceptance Criteria

1. THE Backtest_Module SHALL block go-live IF out-of-sample Sharpe ratio is less than or equal to 1.0.
2. THE Backtest_Module SHALL block go-live IF maximum drawdown is greater than or equal to 15%.
3. THE Backtest_Module SHALL block go-live IF Regime_Engine accuracy is less than or equal to 70% on any symbol when EURUSD-calibrated thresholds are reused without retuning.
4. WHERE a configuration has cleared backtest gates, THE Monitoring_Module SHALL require 3 to 6 calendar months of small-capital live validation before allowing capital scale-up; deviation SHALL be measured as |(live_cumulative_return − backtest_cumulative_return) / backtest_cumulative_return| during the same calendar period; THE Monitoring_Module SHALL block scale-up IF this deviation exceeds 20%.

### Requirement 40: 偏差监控与失效检测

**User Story:** As a trader, I want continuous live monitoring against backtest expectations, so that edge decay is detected early.

#### Acceptance Criteria

1. THE Monitoring_Module SHALL log every entry, exit, regime label, factor vote and risk decision with timestamps for offline analysis.
2. THE Monitoring_Module SHALL recompute live rolling 30-trade Sharpe at the close of every trade and SHALL emit a deviation alert per Requirement 28 when triggered.
3. THE Monitoring_Module SHALL recompute month-to-date sub-strategy concentration daily and SHALL emit alerts per Requirement 31 when triggered.
4. THE Monitoring_Module SHALL recompute Regime_Engine accuracy on a rolling 200-bar window per symbol and SHALL emit an alert IF accuracy falls below 70%.

### Requirement 41: 配置与参数管理

**User Story:** As a trader, I want all thresholds and parameters externalized, so that I can tune the system without recompiling.

#### Acceptance Criteria

1. THE Config_Manager SHALL load all factor thresholds, sub-strategy parameters, risk-budget percentages, session windows and symbol-specific multipliers from an external configuration file at EA startup.
2. THE Config_Manager SHALL validate the configuration file against a schema and SHALL refuse to start the EA IF validation fails, emitting a descriptive error message.
3. WHEN the configuration file is updated while the EA is running, THE Config_Manager SHALL reload the configuration on the next H1 bar boundary and SHALL log the diff between old and new values.
4. IF the reloaded configuration fails validation, THEN THE Config_Manager SHALL retain the previous valid configuration and SHALL emit an alert.
5. THE Config_Manager SHALL provide a pretty-printer that formats the in-memory configuration back into the external file format and SHALL guarantee a round-trip property: parsing then printing then parsing the configuration SHALL produce an equivalent configuration object.
6. WHEN configuration is hot-reloaded per Acceptance Criterion 3, THE Config_Manager SHALL apply the new parameters only to entries opened after the reload; existing positions SHALL continue to be managed under the configuration that was active at their entry time.
