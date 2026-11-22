import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axiosConfig';

const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const computeRecommendedLosslessMb = (origMb, meta) => {
    if (!origMb || origMb <= 0) return 0.1;

    let recommendedMb;
    if (meta && meta.duration > 0 && meta.width > 0 && meta.height > 0) {
        const pixels = meta.width * meta.height;
        const rawIdealVideoKbps = (pixels * 30 * 0.07) / 1000;
        const idealVideoKbps = Math.max(600, Math.min(8000, rawIdealVideoKbps));
        const idealTotalKbps = idealVideoKbps + 128;
        const metadataBasedMb = (idealTotalKbps * meta.duration) / 8192;

        if (metadataBasedMb < origMb * 0.85) {
            recommendedMb = Math.max(origMb * 0.35, metadataBasedMb);
        } else {
            recommendedMb = origMb * 0.80;
        }
    } else {
        recommendedMb = origMb * 0.68;
    }

    const clampedMb = Math.min(origMb * 0.92, recommendedMb);
    return Math.max(0.1, Number(clampedMb.toFixed(2)));
};

const calculateQualityImpact = (targetStr, origMb, recLosslessMb) => {
    if (!origMb || origMb <= 0) {
        return { isValid: false, validationMessage: '' };
    }

    const targetNum = parseFloat(targetStr);
    if (!targetStr || Number.isNaN(targetNum) || targetNum < 0.1) {
        return {
            isValid: false,
            validationMessage: 'Hedef boyut en az 0.1 MB olmalıdır.'
        };
    }

    if (targetNum >= origMb) {
        return {
            isValid: false,
            validationMessage: 'Hedef boyut mevcut dosya boyutundan küçük olmalıdır.'
        };
    }

    const savingsPercent = Math.max(1, Math.round((1 - targetNum / origMb) * 100));
    const losslessRatio = recLosslessMb > 0 ? targetNum / recLosslessMb : 1;

    let qualityLossPercent;
    let level;
    let badgeText;
    let feedbackText;

    if (targetNum >= recLosslessMb * 0.98) {
        qualityLossPercent = 0;
        level = 'lossless';
        badgeText = 'Kayıpsız Kalite (%0 Kayıp)';
        feedbackText = 'Görüntü kalitesinde gözle görülür hiçbir kayıp yaşanmaz. Yalnızca gereksiz veri yoğunluğu (bitrate) optimize edilir.';
    } else if (losslessRatio >= 0.70) {
        qualityLossPercent = Math.max(3, Math.min(20, Math.round((1 - losslessRatio) * 65)));
        level = 'low';
        badgeText = `Çok Düşük Kalite Kaybı (~%${qualityLossPercent})`;
        feedbackText = `Kalite yaklaşık %${qualityLossPercent} oranında düşer. WhatsApp, e-posta ve sosyal medya paylaşımları için oldukça net ve ideal bir dengedir.`;
    } else if (losslessRatio >= 0.40) {
        qualityLossPercent = Math.max(21, Math.min(48, Math.round((1 - losslessRatio) * 75)));
        level = 'medium';
        badgeText = `Orta Düzey Kalite Kaybı (~%${qualityLossPercent})`;
        feedbackText = `Kalite yaklaşık %${qualityLossPercent} oranında düşer. Hızlı hareketli sahnelerde hafif yumuşama görülebilir ancak dosya boyutu ciddi oranda küçülür.`;
    } else {
        qualityLossPercent = Math.max(50, Math.min(90, Math.round((1 - losslessRatio) * 88)));
        level = 'high';
        badgeText = `Yüksek Kalite Kaybı (~%${qualityLossPercent} - Pikselleşme Riski)`;
        feedbackText = `Dikkat: Bu hedef boyuta ulaşmak için kalite yaklaşık %${qualityLossPercent} oranında düşürülecektir. Videoda belirgin pikselleşme ve bulanıklık oluşabilir.`;
    }

    const qualityRetainedPercent = 100 - qualityLossPercent;

    return {
        isValid: true,
        targetNum,
        savingsPercent,
        qualityLossPercent,
        qualityRetainedPercent,
        level,
        badgeText,
        feedbackText
    };
};

const drawSimulatedCompressionFrame = (video, canvas, offscreenCanvasRef, loss) => {
    if (!video || !canvas || video.readyState < 2) return;

    const width = video.videoWidth || 640;
    const height = video.videoHeight || 360;

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (loss <= 0) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(video, 0, 0, width, height);
        return;
    }

    if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
    }
    const offCanvas = offscreenCanvasRef.current;

    const normalizedLoss = Math.min(90, Math.max(1, loss)) / 100;
    const scaleFactor = Math.max(0.10, Math.pow(1 - normalizedLoss * 0.92, 1.55));
    const scaledW = Math.max(20, Math.round(width * scaleFactor));
    const scaledH = Math.max(12, Math.round(height * scaleFactor));

    if (offCanvas.width !== scaledW || offCanvas.height !== scaledH) {
        offCanvas.width = scaledW;
        offCanvas.height = scaledH;
    }

    const offCtx = offCanvas.getContext('2d');
    if (!offCtx) return;

    offCtx.imageSmoothingEnabled = true;
    offCtx.drawImage(video, 0, 0, scaledW, scaledH);

    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = loss < 38;
    ctx.drawImage(offCanvas, 0, 0, scaledW, scaledH, 0, 0, width, height);

    if (loss >= 25 && loss < 38) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(offCanvas, 0, 0, scaledW, scaledH, 0, 0, width, height);
        ctx.restore();
    }
};

const CompressVideo = () => {
    const [file, setFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [title, setTitle] = useState('');
    const [targetSizeMb, setTargetSizeMb] = useState('');
    const [videoMeta, setVideoMeta] = useState(null);
    const [isConfirming, setIsConfirming] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [isDragging, setIsDragging] = useState(false);

    const [sliderPosition, setSliderPosition] = useState(50);
    const [isSliderDragging, setIsSliderDragging] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);

    const fileInputRef = useRef(null);
    const previewContainerRef = useRef(null);
    const previewVideoRef = useRef(null);
    const compressedCanvasRef = useRef(null);
    const offscreenCanvasRef = useRef(null);
    const animFrameRef = useRef(null);
    const navigate = useNavigate();

    const originalSizeMb = file ? file.size / (1024 * 1024) : 0;
    const recommendedLosslessMb = file ? computeRecommendedLosslessMb(originalSizeMb, videoMeta) : 0;
    const losslessSavingsPercent = originalSizeMb > 0
        ? Math.max(1, Math.round((1 - recommendedLosslessMb / originalSizeMb) * 100))
        : 0;
    const qualityImpact = calculateQualityImpact(targetSizeMb, originalSizeMb, recommendedLosslessMb);
    const activeQualityLoss = qualityImpact.isValid ? (qualityImpact.qualityLossPercent || 0) : 0;

    useEffect(() => {
        return () => {
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
            }
            if (animFrameRef.current) {
                cancelAnimationFrame(animFrameRef.current);
            }
        };
    }, [previewUrl]);

    const renderCompressedFrame = () => {
        drawSimulatedCompressionFrame(
            previewVideoRef.current,
            compressedCanvasRef.current,
            offscreenCanvasRef,
            activeQualityLoss
        );
    };

    useEffect(() => {
        drawSimulatedCompressionFrame(
            previewVideoRef.current,
            compressedCanvasRef.current,
            offscreenCanvasRef,
            activeQualityLoss
        );
    }, [activeQualityLoss, targetSizeMb]);

    useEffect(() => {
        const tick = () => {
            drawSimulatedCompressionFrame(
                previewVideoRef.current,
                compressedCanvasRef.current,
                offscreenCanvasRef,
                activeQualityLoss
            );
            if (isPlaying) {
                animFrameRef.current = requestAnimationFrame(tick);
            }
        };

        if (isPlaying) {
            animFrameRef.current = requestAnimationFrame(tick);
        } else if (animFrameRef.current) {
            cancelAnimationFrame(animFrameRef.current);
        }

        return () => {
            if (animFrameRef.current) {
                cancelAnimationFrame(animFrameRef.current);
            }
        };
    }, [isPlaying, activeQualityLoss]);

    const updateSliderFromClientX = useCallback((clientX) => {
        const container = previewContainerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) return;
        const relativeX = clientX - rect.left;
        const percent = Math.max(0, Math.min(100, (relativeX / rect.width) * 100));
        setSliderPosition(Number(percent.toFixed(1)));
    }, []);

    useEffect(() => {
        if (!isSliderDragging) return undefined;

        const handleMouseMove = (e) => {
            updateSliderFromClientX(e.clientX);
        };
        const handleTouchMove = (e) => {
            if (e.touches && e.touches.length > 0) {
                updateSliderFromClientX(e.touches[0].clientX);
            }
        };
        const handleStopDrag = () => {
            setIsSliderDragging(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleStopDrag);
        window.addEventListener('touchmove', handleTouchMove);
        window.addEventListener('touchend', handleStopDrag);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleStopDrag);
            window.removeEventListener('touchmove', handleTouchMove);
            window.removeEventListener('touchend', handleStopDrag);
        };
    }, [isSliderDragging, updateSliderFromClientX]);

    const togglePlayPause = () => {
        const video = previewVideoRef.current;
        if (!video) return;
        if (video.paused || video.ended) {
            video.play().catch(() => { });
        } else {
            video.pause();
        }
    };

    const handleSeekChange = (e) => {
        const video = previewVideoRef.current;
        if (!video) return;
        const newTime = parseFloat(e.target.value);
        if (Number.isFinite(newTime)) {
            video.currentTime = newTime;
            setCurrentTime(newTime);
            renderCompressedFrame();
        }
    };

    const handleFileSelect = (selectedFile) => {
        if (!selectedFile || !selectedFile.type.startsWith('video/')) {
            setError('Lütfen sadece geçerli bir video dosyası seçin veya sürükleyin.');
            return;
        }

        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }

        const newPreviewUrl = URL.createObjectURL(selectedFile);
        setPreviewUrl(newPreviewUrl);
        setFile(selectedFile);
        setError('');
        setIsConfirming(false);
        setVideoMeta(null);
        setIsPlaying(false);
        setCurrentTime(0);
        setSliderPosition(50);

        const origMb = selectedFile.size / (1024 * 1024);
        const initialRecommended = computeRecommendedLosslessMb(origMb, null);
        setTargetSizeMb(String(initialRecommended));
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);
        const droppedFiles = e.dataTransfer.files;
        if (droppedFiles && droppedFiles.length > 0) {
            handleFileSelect(droppedFiles[0]);
        }
    };

    const handleTargetSizeChange = (value) => {
        setTargetSizeMb(value);
        setIsConfirming(false);
        setError('');
    };

    const applyPresetSize = (sizeMb) => {
        const formatted = Math.max(0.1, Number(sizeMb.toFixed(2)));
        setTargetSizeMb(String(formatted));
        setIsConfirming(false);
        setError('');
    };

    const handleProceedToConfirm = (e) => {
        e.preventDefault();
        if (!file) {
            setError('Lütfen bir video dosyası seçin.');
            return;
        }
        if (!title.trim()) {
            setError('Lütfen sıkıştırılmış video için bir başlık girin.');
            return;
        }
        if (!qualityImpact.isValid) {
            setError(qualityImpact.validationMessage || 'Lütfen geçerli bir hedef dosya boyutu girin.');
            return;
        }

        setError('');
        setIsConfirming(true);
    };

    const handleConfirmUpload = async () => {
        if (!file || !qualityImpact.isValid) return;

        setError('');
        setLoading(true);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('title', title.trim());
        formData.append('targetSizeMb', String(qualityImpact.targetNum));

        try {
            await api.post('/videos/compress', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            navigate('/dashboard');
        } catch (err) {
            const errorMessage = err.response?.data?.message
                || (typeof err.response?.data === 'string' ? err.response.data : 'Dosya gönderilemedi.');
            setError(errorMessage);
            setLoading(false);
        }
    };

    return (
        <div className="upload-page">
            <div className="upload-shell">
                <div className="upload-header">
                    <h2 className="upload-title">Videoyu Sıkıştır</h2>
                </div>

                <p className="muted-text page-description">
                    Videonuzun mevcut boyutunu ve maksimum kayıpsız sıkıştırma sınırını analiz edin, hedef dosya boyutuna göre kalite etkisini onaylayarak güvenle küçültün.
                </p>

                {error && <div className="alert alert-top">{error}</div>}

                <form onSubmit={handleProceedToConfirm} className="upload-form">
                    <div className="section-card">
                        <div className="form-grid">
                            <div className="form-field">
                                <label className="field-label">Sıkıştırılmış Video Başlığı</label>
                                <input
                                    type="text"
                                    value={title}
                                    onChange={(e) => {
                                        setTitle(e.target.value);
                                        setIsConfirming(false);
                                    }}
                                    required
                                    placeholder="Örn: Sunum Videosu - Küçültülmüş"
                                    className="text-input"
                                />
                            </div>

                            <div className="form-field">
                                <label className="field-label">Video Dosyası Seç (.mp4, .mov)</label>

                                <div
                                    className={`drag-drop-zone ${isDragging ? 'dragging' : ''}`}
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    onClick={() => fileInputRef.current.click()}
                                >
                                    <input
                                        type="file"
                                        accept="video/mp4,video/x-m4v,video/*"
                                        onChange={(e) => {
                                            if (e.target.files[0]) {
                                                handleFileSelect(e.target.files[0]);
                                            }
                                        }}
                                        ref={fileInputRef}
                                        style={{ display: 'none' }}
                                    />

                                    <div className="drag-content">
                                        <div className="drag-icon">🗜️</div>
                                        {file ? (
                                            <div className="file-success-text">
                                                Seçilen Dosya: {file.name} ({originalSizeMb.toFixed(2)} MB)
                                            </div>
                                        ) : (
                                            <div>
                                                <span className="drag-instructions">Dosyanızı buraya sürükleyin</span> veya
                                                <span className="browse-text">göz atın</span>
                                            </div>
                                        )}
                                        <div className="muted-text file-limits-text">
                                            Dosya seçildiğinde mevcut boyut ve kayıpsız sıkıştırma analizi otomatik hesaplanır.
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {file && (
                                <>
                                    <div className="compression-info-grid">
                                        <div className="size-stat-card">
                                            <span className="size-stat-label">Mevcut Dosya Boyutu</span>
                                            <strong className="size-stat-value">{originalSizeMb.toFixed(2)} MB</strong>
                                            <span className="size-stat-meta">
                                                {videoMeta && videoMeta.width > 0
                                                    ? `${videoMeta.width}x${videoMeta.height}px • ${Math.round(videoMeta.duration)} sn`
                                                    : 'Orijinal kaynak dosya'}
                                            </span>
                                        </div>

                                        <div className="lossless-recommendation-card">
                                            <div className="lossless-card-header">
                                                <div>
                                                    <span className="size-stat-label">Maksimum Kayıpsız Sıkıştırma Önerisi</span>
                                                    <strong className="size-stat-value accent-emerald">
                                                        {recommendedLosslessMb.toFixed(2)} MB
                                                        <span className="savings-pill">~%{losslessSavingsPercent} Küçülme</span>
                                                    </strong>
                                                </div>
                                                <button
                                                    type="button"
                                                    className="secondary-button apply-recommended-btn"
                                                    onClick={() => applyPresetSize(recommendedLosslessMb)}
                                                >
                                                    Önerilen Boyutu Uygula
                                                </button>
                                            </div>
                                            <p className="lossless-card-desc">
                                                Görüntü kalitesinde gözle görülür hiçbir bozulma olmadan inebileceğiniz en düşük ideal dosya boyutu.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="form-field">
                                        <label className="field-label">
                                            Hedef Dosya Boyutu (MB) — Mevcut: {originalSizeMb.toFixed(2)} MB
                                        </label>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min="0.1"
                                            max={Math.max(0.1, Number((originalSizeMb - 0.01).toFixed(2)))}
                                            value={targetSizeMb}
                                            onChange={(e) => handleTargetSizeChange(e.target.value)}
                                            placeholder={`Örn: ${recommendedLosslessMb.toFixed(2)}`}
                                            className="text-input"
                                            required
                                        />

                                        <div className="preset-chips">
                                            <button
                                                type="button"
                                                className={`preset-chip ${Number(targetSizeMb) === recommendedLosslessMb ? 'active' : ''}`}
                                                onClick={() => applyPresetSize(recommendedLosslessMb)}
                                            >
                                                🌟 Kayıpsız Öneri (%{losslessSavingsPercent} Küçült • {recommendedLosslessMb.toFixed(2)} MB)
                                            </button>
                                            <button
                                                type="button"
                                                className="preset-chip"
                                                onClick={() => applyPresetSize(originalSizeMb * 0.5)}
                                            >
                                                %50 Küçült ({Math.max(0.1, Number((originalSizeMb * 0.5).toFixed(2))).toFixed(2)} MB)
                                            </button>
                                            <button
                                                type="button"
                                                className="preset-chip"
                                                onClick={() => applyPresetSize(originalSizeMb * 0.3)}
                                            >
                                                %70 Küçült ({Math.max(0.1, Number((originalSizeMb * 0.3).toFixed(2))).toFixed(2)} MB)
                                            </button>
                                        </div>
                                    </div>

                                    {!qualityImpact.isValid && qualityImpact.validationMessage && (
                                        <div className="alert alert-top">{qualityImpact.validationMessage}</div>
                                    )}

                                    {qualityImpact.isValid && (
                                        <div className={`quality-feedback-card level-${qualityImpact.level}`}>
                                            <div className="quality-feedback-header">
                                                <div>
                                                    <span className="quality-feedback-title">Canlı Kalite ve Boyut Analizi</span>
                                                    <h4 className="quality-feedback-summary">
                                                        {originalSizeMb.toFixed(2)} MB → {qualityImpact.targetNum.toFixed(2)} MB
                                                        <span> (%{qualityImpact.savingsPercent} Boyut Tasarrufu)</span>
                                                    </h4>
                                                </div>
                                                <span className="quality-badge">{qualityImpact.badgeText}</span>
                                            </div>

                                            <div className="quality-meter-track">
                                                <div
                                                    className="quality-meter-fill"
                                                    style={{ width: `${qualityImpact.qualityRetainedPercent}%` }}
                                                />
                                            </div>

                                            <div className="quality-meter-labels">
                                                <span>Tahmini Kalite Korunumu: <strong>%{qualityImpact.qualityRetainedPercent}</strong></span>
                                                <span>Tahmini Kalite Kaybı: <strong>%{qualityImpact.qualityLossPercent}</strong></span>
                                            </div>

                                            <p className="quality-feedback-text">{qualityImpact.feedbackText}</p>
                                        </div>
                                    )}

                                    {previewUrl && (
                                        <div className="comparison-preview-section">
                                            <div className="comparison-preview-header">
                                                <div>
                                                    <span className="quality-feedback-title">Canlı Görüntü Karşılaştırması (Kayar Pencere)</span>
                                                    <h4 className="comparison-preview-subtitle">
                                                        Ortadaki çizgiyi sağa-sola kaydırarak orijinal görüntü ile hedef boyuttaki kalite farkını inceleyin
                                                    </h4>
                                                </div>
                                                <div className="comparison-quick-views">
                                                    <button
                                                        type="button"
                                                        className={`preset-chip ${sliderPosition === 100 ? 'active' : ''}`}
                                                        onClick={() => setSliderPosition(100)}
                                                    >
                                                        Tam Orijinal
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={`preset-chip ${sliderPosition === 50 ? 'active' : ''}`}
                                                        onClick={() => setSliderPosition(50)}
                                                    >
                                                        %50 / %50 Kıyasla
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={`preset-chip ${sliderPosition === 0 ? 'active' : ''}`}
                                                        onClick={() => setSliderPosition(0)}
                                                    >
                                                        Tam Sıkıştırılmış
                                                    </button>
                                                </div>
                                            </div>

                                            <div
                                                ref={previewContainerRef}
                                                className="comparison-stage"
                                                onMouseDown={(e) => {
                                                    setIsSliderDragging(true);
                                                    updateSliderFromClientX(e.clientX);
                                                }}
                                                onTouchStart={(e) => {
                                                    if (e.touches && e.touches.length > 0) {
                                                        setIsSliderDragging(true);
                                                        updateSliderFromClientX(e.touches[0].clientX);
                                                    }
                                                }}
                                            >
                                                <video
                                                    ref={previewVideoRef}
                                                    src={previewUrl}
                                                    className="comparison-video-base"
                                                    playsInline
                                                    onLoadedMetadata={(e) => {
                                                        const vid = e.currentTarget;
                                                        const meta = {
                                                            duration: Number.isFinite(vid.duration) ? vid.duration : 0,
                                                            width: vid.videoWidth || 0,
                                                            height: vid.videoHeight || 0
                                                        };
                                                        setVideoMeta(meta);
                                                        if (file) {
                                                            const origMb = file.size / (1024 * 1024);
                                                            const refinedRecommended = computeRecommendedLosslessMb(origMb, meta);
                                                            setTargetSizeMb(String(refinedRecommended));
                                                        }
                                                    }}
                                                    onLoadedData={() => {
                                                        renderCompressedFrame();
                                                    }}
                                                    onTimeUpdate={(e) => {
                                                        setCurrentTime(e.currentTarget.currentTime);
                                                        if (!isPlaying) {
                                                            renderCompressedFrame();
                                                        }
                                                    }}
                                                    onSeeked={() => {
                                                        renderCompressedFrame();
                                                    }}
                                                    onPlay={() => setIsPlaying(true)}
                                                    onPause={() => {
                                                        setIsPlaying(false);
                                                        renderCompressedFrame();
                                                    }}
                                                    onEnded={() => setIsPlaying(false)}
                                                />

                                                <canvas
                                                    ref={compressedCanvasRef}
                                                    className="comparison-canvas-overlay"
                                                    style={{
                                                        clipPath: `inset(0 0 0 ${sliderPosition}%)`,
                                                        filter: qualityImpact.isValid && qualityImpact.qualityLossPercent > 0
                                                            ? `contrast(${(1 - qualityImpact.qualityLossPercent * 0.0018).toFixed(3)}) saturate(${(1 - qualityImpact.qualityLossPercent * 0.0025).toFixed(3)})`
                                                            : 'none'
                                                    }}
                                                />

                                                <div className="comparison-label comparison-label-left">
                                                    <span className="comparison-label-tag">ORİJİNAL</span>
                                                    <strong>{originalSizeMb.toFixed(2)} MB • %100 Kalite</strong>
                                                </div>

                                                <div
                                                    className={`comparison-label comparison-label-right level-${qualityImpact.isValid ? qualityImpact.level : 'lossless'}`}
                                                >
                                                    <span className="comparison-label-tag">SIKIŞTIRILMIŞ ÖNİZLEME</span>
                                                    <strong>
                                                        {qualityImpact.isValid
                                                            ? `${qualityImpact.targetNum.toFixed(2)} MB • %${qualityImpact.qualityRetainedPercent} Kalite`
                                                            : 'Geçersiz Boyut'}
                                                    </strong>
                                                </div>

                                                <div
                                                    className="comparison-divider"
                                                    style={{ left: `${sliderPosition}%` }}
                                                >
                                                    <div className="comparison-handle" title="Kıyaslamak için sağa veya sola sürükleyin">
                                                        <span>◀</span>
                                                        <span>▶</span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="comparison-controls-bar">
                                                <button
                                                    type="button"
                                                    onClick={togglePlayPause}
                                                    className="secondary-button comparison-play-btn"
                                                >
                                                    {isPlaying ? '⏸ Duraklat' : '▶ Videoyu Oynat'}
                                                </button>

                                                <div className="comparison-seek-wrapper">
                                                    <span className="comparison-time-text">{formatDuration(currentTime)}</span>
                                                    <input
                                                        type="range"
                                                        min="0"
                                                        max={videoMeta && videoMeta.duration > 0 ? videoMeta.duration : 100}
                                                        step="0.05"
                                                        value={currentTime}
                                                        onChange={handleSeekChange}
                                                        className="trim-range comparison-seek-slider"
                                                    />
                                                    <span className="comparison-time-text">
                                                        {formatDuration(videoMeta ? videoMeta.duration : 0)}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {!isConfirming ? (
                        <button
                            type="submit"
                            disabled={loading || !file || !qualityImpact.isValid}
                            className="upload-button"
                        >
                            Kalite Analizini Gör ve Devam Et
                        </button>
                    ) : (
                        <div className="confirmation-modal-card">
                            <div className="confirmation-header">
                                <span className="confirmation-icon">🛡️</span>
                                <div>
                                    <h3 className="confirmation-title">Sıkıştırma ve Kalite Onayı</h3>
                                    <p className="muted-text">
                                        İşlem başlatılmadan önce aşağıdaki boyut ve kalite değişimini onaylayın:
                                    </p>
                                </div>
                            </div>

                            <div className="confirmation-summary-grid">
                                <div className="confirmation-stat">
                                    <span>Mevcut Boyut</span>
                                    <strong>{originalSizeMb.toFixed(2)} MB</strong>
                                </div>
                                <div className="confirmation-stat">
                                    <span>Hedeflenen Boyut</span>
                                    <strong>
                                        {qualityImpact.targetNum.toFixed(2)} MB (%{qualityImpact.savingsPercent} Küçülme)
                                    </strong>
                                </div>
                                <div className="confirmation-stat">
                                    <span>Tahmini Kalite Kaybı</span>
                                    <strong>
                                        %{qualityImpact.qualityLossPercent} Kayıp (Kalite Korunumu: %{qualityImpact.qualityRetainedPercent})
                                    </strong>
                                </div>
                            </div>

                            <div className={`quality-feedback-card level-${qualityImpact.level} confirmation-feedback-box`}>
                                <strong>{qualityImpact.badgeText}:</strong> {qualityImpact.feedbackText}
                            </div>

                            <p className="confirmation-question">
                                Hesaplanan kalite etkisini onaylıyor ve sıkıştırma işlemini başlatmak istiyor musunuz?
                            </p>

                            <div className="confirmation-actions">
                                <button
                                    type="button"
                                    onClick={handleConfirmUpload}
                                    disabled={loading}
                                    className="upload-button"
                                >
                                    {loading ? 'Sıkıştırılıyor (Bekleyin)...' : 'Onaylıyorum, Sıkıştırmayı Başlat'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsConfirming(false)}
                                    disabled={loading}
                                    className="secondary-button"
                                >
                                    Hedef Boyutu Düzenle
                                </button>
                            </div>
                        </div>
                    )}
                </form>
            </div>
        </div>
    );
};

export default CompressVideo;
