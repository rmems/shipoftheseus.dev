//! Selectable `axon-encoder` modes behind the V1 adapter.
//!
//! The adapter owns orchestration only: browser input is normalized into the
//! stable [`ENCODER_CHANNELS`]-channel encoder-input contract and handed to
//! exactly one upstream encoder per step. No encoding algorithm is
//! reimplemented here.
//!
//! Only the streaming [`Encoder::encode_step`] path is used. That keeps every
//! v1 mode deterministic: the batch [`Encoder::encode`] path on rate encoders
//! draws from thread-local RNG and is never called here.

use axon_encoder::Encoder;
use axon_encoder::encoders::{DeltaEncoder, RateEncoder, TemporalEncoder};
use kinetic_signals::{ZScore, compute_signal_stats};

/// Channel count shared by the normalization contract and every v1 encoder.
pub const ENCODER_CHANNELS: usize = 16;

/// Minimum scale applied to the `kinetic-signals` variance before z-scoring,
/// so constant input still normalizes to a finite feature vector.
pub const NORMALIZATION_FLOOR: f64 = 0.001;

/// Contract version that adds selectable encoder modes and spike-train
/// diagnostics. Version 3 remains the legacy delta-only contract.
pub const CONTRACT_VERSION_V4: u8 = 4;

/// Delta threshold inherited from the legacy delta-only contract.
const DELTA_THRESHOLD: f32 = 0.05;

/// Temporal change-detection threshold over the sliding window mean.
const TEMPORAL_THRESHOLD: f32 = 0.3;

/// Temporal sliding-window length in logical steps.
const TEMPORAL_WINDOW: usize = 6;

/// Rate ceiling in Hz. One logical demo tick is [`RATE_DT_SECONDS`] long, so
/// a fully active channel emits `RATE_MAX_HZ * RATE_DT_SECONDS` spikes per
/// step.
const RATE_MAX_HZ: f32 = 20.0;

/// Logical demo-tick duration in seconds; matches `DEMO_TICK_MS` (50 ms).
const RATE_DT_SECONDS: f32 = 0.05;

/// Selectable v1 encoder modes.
///
/// Discriminants are part of the init-config ABI (`[4, mode]`) and the
/// `encoder_mode` state field: renumbering a shipped mode requires a
/// contract-version increase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EncoderMode {
    Delta = 0,
    Temporal = 1,
    Rate = 2,
}

impl EncoderMode {
    /// V1 default: change-driven temporal encoding suits pointer telemetry,
    /// where bursts of motion matter more than absolute position.
    pub const DEFAULT: Self = Self::Temporal;

    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Delta => "delta",
            Self::Temporal => "temporal",
            Self::Rate => "rate",
        }
    }

    /// Parse a mode byte. Values 3 (`population`) and 4 (`predictive`) are the
    /// reserved v1 extension path: recognized but rejected until a later
    /// contract version wires a browser-safe upstream for them.
    pub fn parse(value: u8) -> Result<Self, String> {
        match value {
            0 => Ok(Self::Delta),
            1 => Ok(Self::Temporal),
            2 => Ok(Self::Rate),
            3 | 4 => Err(format!(
                "encoder mode {value} is reserved for a later contract version"
            )),
            other => Err(format!("unknown encoder mode {other}")),
        }
    }
}

/// The single active upstream encoder. Exactly one variant advances per step;
/// inactive modes hold no state because the mode is fixed at construction.
pub enum V1Encoder {
    Delta(DeltaEncoder),
    Temporal(TemporalEncoder),
    Rate(RateEncoder),
}

impl V1Encoder {
    #[must_use]
    pub fn for_mode(mode: EncoderMode) -> Self {
        match mode {
            EncoderMode::Delta => Self::Delta(DeltaEncoder::new(DELTA_THRESHOLD, ENCODER_CHANNELS)),
            EncoderMode::Temporal => Self::Temporal(
                TemporalEncoder::try_new(
                    TEMPORAL_WINDOW,
                    vec![(TEMPORAL_THRESHOLD, 1)],
                    ENCODER_CHANNELS,
                )
                .expect("pinned temporal encoder configuration is valid"),
            ),
            EncoderMode::Rate => Self::Rate(
                RateEncoder::try_new(0.0, RATE_MAX_HZ, (0.0, 1.0), RATE_DT_SECONDS)
                    .expect("pinned rate encoder configuration is valid"),
            ),
        }
    }

    #[must_use]
    pub fn mode(&self) -> EncoderMode {
        match self {
            Self::Delta(_) => EncoderMode::Delta,
            Self::Temporal(_) => EncoderMode::Temporal,
            Self::Rate(_) => EncoderMode::Rate,
        }
    }

    /// Encode one step of normalized features into emitting channel ids.
    pub fn encode_step(&mut self, input: &[f32]) -> Vec<u16> {
        let output = match self {
            Self::Delta(encoder) => encoder.encode_step(input),
            Self::Temporal(encoder) => encoder.encode_step(input),
            Self::Rate(encoder) => encoder.encode_step(input),
        };
        output.spikes.iter().map(|spike| spike.channel).collect()
    }
}

/// Normalize raw browser samples into the stable encoder-input contract: one
/// `kinetic-signals` z-score magnitude per channel, clamped to `[0, 1]`.
///
/// The mapping is mode-independent, so switching the encoder mode never
/// changes what the renderer-facing snapshot means — only which spikes the
/// same features produce.
#[must_use]
pub fn normalize_to_encoder_input(samples: &[f32]) -> [f32; ENCODER_CHANNELS] {
    let raw: Vec<f64> = samples.iter().map(|sample| f64::from(*sample)).collect();
    let stats = compute_signal_stats(&raw);
    let scale = stats.variance.sqrt().max(NORMALIZATION_FLOOR);
    let mut features = [0.0_f32; ENCODER_CHANNELS];
    for (index, sample) in raw.iter().take(ENCODER_CHANNELS).enumerate() {
        features[index] = (ZScore::compute(*sample, stats.mean, scale).abs() as f32).min(1.0);
    }
    features
}
