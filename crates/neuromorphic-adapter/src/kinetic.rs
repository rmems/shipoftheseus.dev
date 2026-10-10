//! Contract-5 interactive sensory path: pointer/touch/demo telemetry →
//! `kinetic-signals` features → `axon-encoder`.
//!
//! The site layer owns raw DOM input handling and sends one telemetry packet
//! per logical tick: `[x, y, pressure]`, with `x`/`y` relative to the demo
//! island (`0..=1` inside it) and `pressure` the pointer contact strength. This
//! module turns that stream into the stable [`ENCODER_CHANNELS`]-channel
//! encoder-input contract using `kinetic-signals` streaming primitives (`EMA`,
//! `VolEstimator`, `compute_surprise`). Every feature is clamped to `[0, 1]`
//! before it reaches `axon-encoder`, so out-of-range input can never inject
//! unbounded values into the SNN.
//!
//! The adapter only differences consecutive positions (the velocity input
//! `kinetic-signals` consumes) and rescales to fixed full-scale constants; all
//! smoothing, volatility, and surprise extraction is delegated upstream.

use kinetic_signals::{EMA, SurpriseParams, VolEstimator, compute_surprise};

use crate::encoder::ENCODER_CHANNELS;

/// Values per telemetry packet: `[x, y, pressure]`.
pub const TELEMETRY_PACKET_LEN: usize = 3;

/// Velocity (island fractions per logical tick) that maps to feature `1.0`.
/// At the 50 ms demo tick this is two island widths per second.
pub const VELOCITY_FULL_SCALE: f64 = 0.1;

/// Speed change per tick that maps to feature `1.0`.
pub const ACCELERATION_FULL_SCALE: f64 = 0.05;

/// Surprise z-score magnitude that maps to feature `1.0`.
pub const SURPRISE_FULL_SCALE: f64 = 3.0;

/// Offset keeping speed strictly positive so `compute_surprise` (a log-ratio)
/// stays defined while the pointer is at rest.
const SPEED_FLOOR: f64 = 0.005;

const FAST_EMA_PERIOD: usize = 3;
const SLOW_EMA_PERIOD: usize = 12;
const POSITION_EMA_PERIOD: usize = 6;
const PRESSURE_EMA_PERIOD: usize = 8;
const VOLATILITY_WINDOW: usize = 16;

/// Feature channel layout for contract 5. Indices are part of the contract:
/// reordering them changes which spikes a recorded trace produces and requires
/// a contract-version increase.
pub mod channel {
    pub const X: usize = 0;
    pub const Y: usize = 1;
    pub const PRESSURE: usize = 2;
    pub const VELOCITY_X_POSITIVE: usize = 3;
    pub const VELOCITY_X_NEGATIVE: usize = 4;
    pub const VELOCITY_Y_POSITIVE: usize = 5;
    pub const VELOCITY_Y_NEGATIVE: usize = 6;
    pub const SPEED: usize = 7;
    pub const SPEED_FAST_EMA: usize = 8;
    pub const SPEED_SLOW_EMA: usize = 9;
    pub const ACCELERATION: usize = 10;
    pub const SPEED_VOLATILITY: usize = 11;
    pub const SPEED_SURPRISE: usize = 12;
    pub const PRESSURE_EMA: usize = 13;
    pub const X_EMA: usize = 14;
    pub const Y_EMA: usize = 15;
}

/// Stateful `kinetic-signals` feature extractor for one runtime instance.
pub struct KineticExtractor {
    previous: Option<(f64, f64, f64)>,
    speed_fast: EMA,
    speed_slow: EMA,
    x_smooth: EMA,
    y_smooth: EMA,
    pressure_smooth: EMA,
    speed_volatility: VolEstimator,
    surprise: SurpriseParams<f64>,
}

impl Default for KineticExtractor {
    fn default() -> Self {
        Self::new()
    }
}

impl KineticExtractor {
    #[must_use]
    pub fn new() -> Self {
        Self {
            previous: None,
            speed_fast: EMA::new(FAST_EMA_PERIOD),
            speed_slow: EMA::new(SLOW_EMA_PERIOD),
            x_smooth: EMA::new(POSITION_EMA_PERIOD),
            y_smooth: EMA::new(POSITION_EMA_PERIOD),
            pressure_smooth: EMA::new(PRESSURE_EMA_PERIOD),
            speed_volatility: VolEstimator::new(VOLATILITY_WINDOW),
            // One logical tick per transition with unit volatility, so the
            // z-score is the plain log-ratio of consecutive speeds.
            surprise: SurpriseParams {
                mu: 0.0,
                sigma: 1.0,
                dt: 1.0,
                threshold: SURPRISE_FULL_SCALE,
            },
        }
    }

    /// Extract one tick of clamped features from a validated, finite packet.
    ///
    /// Positions and pressure are clamped to `[0, 1]` before differencing, so
    /// a pointer outside the island saturates at the edge rather than
    /// producing an unbounded velocity.
    pub fn extract(&mut self, packet: &[f32; TELEMETRY_PACKET_LEN]) -> [f32; ENCODER_CHANNELS] {
        let x = unit(f64::from(packet[0]));
        let y = unit(f64::from(packet[1]));
        let pressure = unit(f64::from(packet[2]));

        let (previous_x, previous_y, previous_speed) = self.previous.unwrap_or((x, y, 0.0));
        let velocity_x = x - previous_x;
        let velocity_y = y - previous_y;
        let speed = velocity_x.hypot(velocity_y);
        let acceleration = (speed - previous_speed).abs();
        self.previous = Some((x, y, speed));

        let fast = self.speed_fast.update(speed);
        let slow = self.speed_slow.update(speed);
        self.speed_volatility
            .push((acceleration / VELOCITY_FULL_SCALE) as f32);
        let surprise = compute_surprise(
            speed + SPEED_FLOOR,
            previous_speed + SPEED_FLOOR,
            &self.surprise,
        )
        .surprise;

        let mut features = [0.0_f64; ENCODER_CHANNELS];
        features[channel::X] = x;
        features[channel::Y] = y;
        features[channel::PRESSURE] = pressure;
        features[channel::VELOCITY_X_POSITIVE] = velocity_x.max(0.0) / VELOCITY_FULL_SCALE;
        features[channel::VELOCITY_X_NEGATIVE] = (-velocity_x).max(0.0) / VELOCITY_FULL_SCALE;
        features[channel::VELOCITY_Y_POSITIVE] = velocity_y.max(0.0) / VELOCITY_FULL_SCALE;
        features[channel::VELOCITY_Y_NEGATIVE] = (-velocity_y).max(0.0) / VELOCITY_FULL_SCALE;
        features[channel::SPEED] = speed / VELOCITY_FULL_SCALE;
        features[channel::SPEED_FAST_EMA] = fast / VELOCITY_FULL_SCALE;
        features[channel::SPEED_SLOW_EMA] = slow / VELOCITY_FULL_SCALE;
        features[channel::ACCELERATION] = acceleration / ACCELERATION_FULL_SCALE;
        features[channel::SPEED_VOLATILITY] = f64::from(self.speed_volatility.rms());
        features[channel::SPEED_SURPRISE] = surprise / SURPRISE_FULL_SCALE;
        features[channel::PRESSURE_EMA] = self.pressure_smooth.update(pressure);
        features[channel::X_EMA] = self.x_smooth.update(x);
        features[channel::Y_EMA] = self.y_smooth.update(y);

        features.map(|feature| unit(feature) as f32)
    }
}

/// Clamp to `[0, 1]`; inputs are already validated finite.
fn unit(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}
