//! Audio sink for the AirPlay 1 receiver.
//!
//! Writes decoded interleaved i16 PCM to a named pipe so another process
//! (the Discord bot) can consume the audio.

use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use log::{debug, warn};

use openairplay1::AudioSink;

/// The SET_PARAMETER mute sentinel.
const MUTE_DB: f32 = -144.0;

/// Convert an AirPlay dB attenuation to a linear gain in [0.0, 1.0].
pub fn volume_to_gain(db: f32) -> f32 {
    if db <= MUTE_DB {
        return 0.0;
    }

    let gain = 10f32.powf(db / 20.0);
    gain.clamp(0.0, 1.0)
}

/// Scale interleaved i16 PCM by gain in place.
fn apply_gain(samples: &mut [i16], gain: f32) {
    if gain >= 1.0 {
        return;
    }

    if gain <= 0.0 {
        samples.fill(0);
        return;
    }

    for sample in samples.iter_mut() {
        let scaled = (*sample as f32 * gain).round();
        *sample = scaled.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
    }
}

/// Shared playback gain.
///
/// AirPlay volume events update this value, and the sink applies it to
/// subsequent PCM chunks.
#[derive(Clone)]
pub struct SharedGain(Arc<AtomicU32>);

impl SharedGain {
    pub fn new() -> SharedGain {
        SharedGain(Arc::new(AtomicU32::new(1.0f32.to_bits())))
    }

    pub fn set(&self, gain: f32) {
        self.0
            .store(gain.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
}

impl Default for SharedGain {
    fn default() -> SharedGain {
        SharedGain::new()
    }
}

/// Discards audio.
pub struct NullSink;

impl AudioSink for NullSink {
    fn write(&mut self, _pcm: &[i16]) {}

    fn flush(&mut self) {}
}

/// Writes raw interleaved S16_LE PCM to a FIFO.
///
/// The Discord bot can read this FIFO and turn the PCM into a Discord
/// audio stream.
pub struct PipeSink {
    pipe: Option<BufWriter<std::fs::File>>,
    gain: SharedGain,
    scratch: Vec<i16>,
}

impl PipeSink {
    pub fn open(pipe_path: &str, gain: SharedGain) -> PipeSink {
        let pipe = match OpenOptions::new().write(true).open(pipe_path) {
            Ok(file) => {
                debug!("player: opened audio pipe {pipe_path}");
                Some(BufWriter::new(file))
            }
            Err(e) => {
                warn!("player: cannot open audio pipe {pipe_path}: {e}");
                None
            }
        };

        PipeSink {
            pipe,
            gain,
            scratch: Vec::new(),
        }
    }
}

impl AudioSink for PipeSink {
    fn write(&mut self, pcm: &[i16]) {
        let Some(pipe) = self.pipe.as_mut() else {
            return;
        };

        self.scratch.clear();
        self.scratch.extend_from_slice(pcm);

        apply_gain(&mut self.scratch, self.gain.get());

        // i16 samples are native-endian on Apple Silicon, which is little
        // endian. Convert explicitly to S16_LE for the Node process.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                self.scratch.as_ptr() as *const u8,
                self.scratch.len() * std::mem::size_of::<i16>(),
            )
        };

        if let Err(e) = pipe.write_all(bytes) {
            warn!("player: audio pipe write failed: {e}");
            self.pipe = None;
        }
    }

    fn flush(&mut self) {
        if let Some(pipe) = self.pipe.as_mut() {
            if let Err(e) = pipe.flush() {
                warn!("player: audio pipe flush failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_volume_is_unity() {
        assert_eq!(volume_to_gain(0.0), 1.0);
    }

    #[test]
    fn mute_is_zero() {
        assert_eq!(volume_to_gain(-144.0), 0.0);
        assert_eq!(volume_to_gain(-200.0), 0.0);
    }

    #[test]
    fn minus_six_db_is_about_half() {
        let g = volume_to_gain(-6.0206);
        assert!((g - 0.5).abs() < 0.001);
    }

    #[test]
    fn zero_gain_silences() {
        let mut samples = [100i16, -200, 30000];
        apply_gain(&mut samples, 0.0);
        assert_eq!(samples, [0, 0, 0]);
    }

    #[test]
    fn half_gain_scales() {
        let mut samples = [100i16, -100, 32767];
        apply_gain(&mut samples, 0.5);
        assert_eq!(samples, [50, -50, 16384]);
    }

    #[test]
    fn shared_gain_clamps() {
        let gain = SharedGain::new();

        assert_eq!(gain.get(), 1.0);

        gain.set(2.0);
        assert_eq!(gain.get(), 1.0);

        gain.set(-1.0);
        assert_eq!(gain.get(), 0.0);
    }
}