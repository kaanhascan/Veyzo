package com.veyzo.media_editing_system.service;

import com.veyzo.media_editing_system.model.Video;
import com.veyzo.media_editing_system.model.VideoStatus;
import com.veyzo.media_editing_system.repository.VideoRepository;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class FfmpegService {

    private final VideoRepository videoRepository;
    private final String PROCESSED_DIR = System.getProperty("user.dir") + "/uploads/processed/";
    private static final long FFMPEG_TIMEOUT_MINUTES = 10;

    @PostConstruct
    public void recoverStuckVideosOnStartup() {
        List<Video> stuckVideos = videoRepository.findByStatusIn(
                List.of(VideoStatus.PENDING, VideoStatus.PROCESSING)
        );
        if (!stuckVideos.isEmpty()) {
            for (Video video : stuckVideos) {
                video.setStatus(VideoStatus.FAILED);
            }
            videoRepository.saveAll(stuckVideos);
            log.warn("Uygulama başlatılırken yarıda kalmış {} adet video FAILED statüsüne çekildi.", stuckVideos.size());
        }
    }

    @Async("ffmpegTaskExecutor")
    public void processVideoTrimming(UUID videoId, String startTime, String duration) {

        Video video = videoRepository.findById(videoId)
                .orElseThrow(() -> new RuntimeException("Video bulunamadı"));

        try {
            video.setStatus(VideoStatus.PROCESSING);
            videoRepository.save(video);

            File directory = new File(PROCESSED_DIR);
            if (!directory.exists()) directory.mkdirs();

            String outputFileName = "trimmed_" + video.getOriginalFileName();
            String outputFilePath = PROCESSED_DIR + outputFileName;

            ProcessBuilder processBuilder = new ProcessBuilder(
                    "ffmpeg", "-y",
                    "-i", video.getOriginalFilePath(),
                    "-ss", startTime,
                    "-t", duration,
                    "-c", "copy",
                    outputFilePath
            );

            boolean success = runFfmpegProcess(processBuilder, "TRIM");

            if (success) {
                video.setStatus(VideoStatus.COMPLETED);
                video.setProcessedFileName(outputFileName);
                video.setProcessedFilePath(outputFilePath);
            } else {
                video.setStatus(VideoStatus.FAILED);
            }

        } catch (Exception e) {
            log.error("Video kırpma hatası (videoId={}): {}", videoId, e.getMessage(), e);
            video.setStatus(VideoStatus.FAILED);
        } finally {
            videoRepository.save(video);
        }
    }

    @Async("ffmpegTaskExecutor")
    public void processAudioExtraction(UUID videoId) {

        Video video = videoRepository.findById(videoId)
                .orElseThrow(() -> new RuntimeException("Video bulunamadı"));

        try {
            video.setStatus(VideoStatus.PROCESSING);
            videoRepository.save(video);

            File directory = new File(PROCESSED_DIR);
            if (!directory.exists()) directory.mkdirs();

            String outputFileName = "audio_" + UUID.randomUUID() + ".mp3";
            String outputFilePath = PROCESSED_DIR + outputFileName;

            ProcessBuilder processBuilder = new ProcessBuilder(
                    "ffmpeg", "-y",
                    "-i", video.getOriginalFilePath(),
                    "-vn",
                    "-acodec", "libmp3lame",
                    "-q:a", "2",
                    outputFilePath
            );

            boolean success = runFfmpegProcess(processBuilder, "AUDIO");

            if (success) {
                video.setStatus(VideoStatus.COMPLETED);
                video.setProcessedFileName(outputFileName);
                video.setProcessedFilePath(outputFilePath);
            } else {
                video.setStatus(VideoStatus.FAILED);
            }

        } catch (Exception e) {
            log.error("Ses ayırma hatası (videoId={}): {}", videoId, e.getMessage(), e);
            video.setStatus(VideoStatus.FAILED);
        } finally {
            videoRepository.save(video);
        }
    }

    @Async("ffmpegTaskExecutor")
    public void processVideoMerging(UUID mergedVideoId, List<UUID> sourceVideoIds) {
        Video mergedVideo = videoRepository.findById(mergedVideoId)
                .orElseThrow(() -> new RuntimeException("Birleştirilecek video kaydı bulunamadı"));

        File listFile = null;
        try {
            mergedVideo.setStatus(VideoStatus.PROCESSING);
            videoRepository.save(mergedVideo);

            Map<UUID, Video> videoMap = videoRepository.findAllById(sourceVideoIds).stream()
                    .collect(Collectors.toMap(Video::getId, Function.identity()));

            File directory = new File(PROCESSED_DIR);
            if (!directory.exists()) directory.mkdirs();

            String outputFileName = "merged_" + UUID.randomUUID() + ".mp4";
            String outputFilePath = PROCESSED_DIR + outputFileName;

            listFile = new File(PROCESSED_DIR + "concat_" + mergedVideo.getId() + ".txt");
            try (PrintWriter pw = new PrintWriter(listFile)) {
                for (UUID id : sourceVideoIds) {
                    Video v = videoMap.get(id);
                    if (v != null && v.getProcessedFilePath() != null) {
                        pw.println("file '" + v.getProcessedFilePath().replace("\\", "/") + "'");
                    }
                }
            }

            ProcessBuilder processBuilder = new ProcessBuilder(
                    "ffmpeg", "-y",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", listFile.getAbsolutePath(),
                    "-c:v", "libx264",
                    "-threads", "2",
                    "-c:a", "aac",
                    "-preset", "fast",
                    outputFilePath
            );

            boolean success = runFfmpegProcess(processBuilder, "MERGE");

            if (success) {
                mergedVideo.setStatus(VideoStatus.COMPLETED);
                mergedVideo.setProcessedFileName(outputFileName);
                mergedVideo.setProcessedFilePath(outputFilePath);
            } else {
                mergedVideo.setStatus(VideoStatus.FAILED);
            }
        } catch (Exception e) {
            log.error("Video birleştirme hatası (mergedVideoId={}): {}", mergedVideoId, e.getMessage(), e);
            mergedVideo.setStatus(VideoStatus.FAILED);
        } finally {
            if (listFile != null && listFile.exists()) {
                listFile.delete();
            }
            videoRepository.save(mergedVideo);
        }
    }

    @Async("ffmpegTaskExecutor")
    public void processGifConversion(UUID videoId) {
        Video video = videoRepository.findById(videoId)
                .orElseThrow(() -> new RuntimeException("GIF için video kaydı bulunamadı"));

        try {
            video.setStatus(VideoStatus.PROCESSING);
            videoRepository.save(video);

            File directory = new File(PROCESSED_DIR);
            if (!directory.exists()) directory.mkdirs();

            String outputFileName = "gif_" + UUID.randomUUID() + ".gif";
            String outputFilePath = PROCESSED_DIR + outputFileName;

            ProcessBuilder processBuilder = new ProcessBuilder(
                    "ffmpeg", "-y",
                    "-i", video.getOriginalFilePath(),
                    "-vf", "fps=10,scale=480:-1:flags=lanczos",
                    outputFilePath
            );

            boolean success = runFfmpegProcess(processBuilder, "GIF");

            if (success) {
                video.setStatus(VideoStatus.COMPLETED);
                video.setProcessedFileName(outputFileName);
                video.setProcessedFilePath(outputFilePath);
            } else {
                video.setStatus(VideoStatus.FAILED);
            }
        } catch (Exception e) {
            log.error("GIF dönüştürme hatası (videoId={}): {}", videoId, e.getMessage(), e);
            video.setStatus(VideoStatus.FAILED);
        } finally {
            videoRepository.save(video);
        }
    }

    @Async("ffmpegTaskExecutor")
    public void processVideoCompression(UUID videoId, Double targetSizeMb) {
        Video initialVideo = videoRepository.findById(videoId)
                .orElseThrow(() -> new RuntimeException("Sıkıştırma için video kaydı bulunamadı"));

        initialVideo.setStatus(VideoStatus.PROCESSING);
        videoRepository.save(initialVideo);

        boolean isSuccess = false;
        String finalOutputFileName = null;
        String finalOutputFilePath = null;

        try {
            File directory = new File(PROCESSED_DIR);
            if (!directory.exists()) directory.mkdirs();

            String outputFileName = "compressed_" + UUID.randomUUID() + ".mp4";
            String outputFilePath = PROCESSED_DIR + outputFileName;

            ProcessBuilder processBuilder;
            if (targetSizeMb != null && targetSizeMb > 0) {
                File originalFile = new File(initialVideo.getOriginalFilePath());
                double originalSizeMb = originalFile.exists() ? originalFile.length() / (1024.0 * 1024.0) : 0;
                double durationSeconds = probeVideoDurationSeconds(initialVideo.getOriginalFilePath());

                if (durationSeconds > 0) {
                    double targetTotalKilobits = targetSizeMb * 8192.0 * 0.95;
                    double totalKbps = targetTotalKilobits / durationSeconds;

                    int audioBitrateKbps;
                    if (totalKbps < 120) {
                        audioBitrateKbps = 48;
                    } else if (totalKbps < 240) {
                        audioBitrateKbps = 64;
                    } else if (totalKbps < 400) {
                        audioBitrateKbps = 96;
                    } else {
                        audioBitrateKbps = 128;
                    }

                    int videoBitrateKbps = Math.max(40, (int) Math.floor(totalKbps - audioBitrateKbps));
                    int maxRateKbps = Math.max(videoBitrateKbps + 10, (int) Math.round(videoBitrateKbps * 1.15));
                    int bufSizeKbps = videoBitrateKbps * 2;

                    processBuilder = new ProcessBuilder(
                            "ffmpeg", "-y",
                            "-i", initialVideo.getOriginalFilePath(),
                            "-vcodec", "libx264",
                            "-b:v", videoBitrateKbps + "k",
                            "-maxrate", maxRateKbps + "k",
                            "-bufsize", bufSizeKbps + "k",
                            "-preset", "fast",
                            "-c:a", "aac",
                            "-b:a", audioBitrateKbps + "k",
                            outputFilePath
                    );
                } else {
                    double ratio = (originalSizeMb > 0) ? (targetSizeMb / originalSizeMb) : 0.5;
                    int crf = Math.max(20, Math.min(42, (int) Math.round(20 + (1.0 - ratio) * 24)));

                    processBuilder = new ProcessBuilder(
                            "ffmpeg", "-y",
                            "-i", initialVideo.getOriginalFilePath(),
                            "-vcodec", "libx264",
                            "-crf", String.valueOf(crf),
                            "-preset", "fast",
                            "-c:a", "aac",
                            "-b:a", "128k",
                            outputFilePath
                    );
                }
            } else {
                processBuilder = new ProcessBuilder(
                        "ffmpeg", "-y",
                        "-i", initialVideo.getOriginalFilePath(),
                        "-vcodec", "libx264",
                        "-crf", "28",
                        "-preset", "fast",
                        "-c:a", "aac",
                        "-b:a", "128k",
                        outputFilePath
                );
            }

            if (runFfmpegProcess(processBuilder, "COMPRESS")) {
                isSuccess = true;
                finalOutputFileName = outputFileName;
                finalOutputFilePath = outputFilePath;
            }
        } catch (Exception e) {
            log.error("Video sıkıştırma hatası (videoId={}): {}", videoId, e.getMessage(), e);
        } finally {
            Optional<Video> optionalVideo = videoRepository.findById(videoId);

            if (optionalVideo.isPresent()) {
                Video latestVideo = optionalVideo.get();

                if (isSuccess) {
                    latestVideo.setStatus(VideoStatus.COMPLETED);
                    latestVideo.setProcessedFileName(finalOutputFileName);
                    latestVideo.setProcessedFilePath(finalOutputFilePath);
                } else {
                    latestVideo.setStatus(VideoStatus.FAILED);
                }

                videoRepository.save(latestVideo);
            }
        }
    }

    private double probeVideoDurationSeconds(String filePath) {
        try {
            ProcessBuilder ffprobeBuilder = new ProcessBuilder(
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    filePath
            );
            ffprobeBuilder.redirectErrorStream(true);
            Process ffprobeProcess = ffprobeBuilder.start();

            String durationLine = null;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(ffprobeProcess.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    if (!trimmed.isEmpty() && durationLine == null) {
                        durationLine = trimmed;
                    }
                }
            }

            boolean finished = ffprobeProcess.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                ffprobeProcess.destroyForcibly();
            } else if (ffprobeProcess.exitValue() == 0 && durationLine != null) {
                double duration = Double.parseDouble(durationLine);
                if (duration > 0) {
                    return duration;
                }
            }
        } catch (Exception e) {
            log.debug("ffprobe ile video süresi alınamadı, ffmpeg fallback denenecek: {}", e.getMessage());
        }

        try {
            ProcessBuilder ffmpegBuilder = new ProcessBuilder("ffmpeg", "-i", filePath);
            ffmpegBuilder.redirectErrorStream(true);
            Process ffmpegProcess = ffmpegBuilder.start();

            Pattern durationPattern = Pattern.compile("Duration:\\s*(\\d{2}):(\\d{2}):(\\d{2}(?:\\.\\d+)?)");
            double parsedDuration = -1;

            try (BufferedReader reader = new BufferedReader(new InputStreamReader(ffmpegProcess.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (parsedDuration <= 0) {
                        Matcher matcher = durationPattern.matcher(line);
                        if (matcher.find()) {
                            int hours = Integer.parseInt(matcher.group(1));
                            int minutes = Integer.parseInt(matcher.group(2));
                            double seconds = Double.parseDouble(matcher.group(3));
                            parsedDuration = hours * 3600.0 + minutes * 60.0 + seconds;
                        }
                    }
                }
            }

            boolean finished = ffmpegProcess.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                ffmpegProcess.destroyForcibly();
            }

            if (parsedDuration > 0) {
                return parsedDuration;
            }
        } catch (Exception e) {
            log.warn("Video süresi tespit edilemedi (filePath={}): {}", filePath, e.getMessage());
        }

        return -1;
    }

    private boolean runFfmpegProcess(ProcessBuilder processBuilder, String operationTag) throws Exception {
        processBuilder.redirectErrorStream(true);
        Process process = processBuilder.start();

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                log.debug("[FFMPEG {}]: {}", operationTag, line);
            }
        }

        boolean finished = process.waitFor(FFMPEG_TIMEOUT_MINUTES, TimeUnit.MINUTES);
        if (!finished) {
            process.destroyForcibly();
            log.error("[FFMPEG {}] İşlem zaman aşımına uğradı ({} dk) ve sonlandırıldı.", operationTag, FFMPEG_TIMEOUT_MINUTES);
            return false;
        }

        int exitCode = process.exitValue();
        if (exitCode != 0) {
            log.error("[FFMPEG {}] İşlem başarısız çıkış kodu ile sonlandı: {}", operationTag, exitCode);
            return false;
        }
        return true;
    }
}
