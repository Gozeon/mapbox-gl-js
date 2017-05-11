'use strict';

const util = require('../util/util');
const ajax = require('../util/ajax');
const Evented = require('../util/evented');
const loadTileJSON = require('./load_tilejson');
const normalizeURL = require('../util/mapbox').normalizeTileURL;
const TileBounds = require('./tile_bounds');
const LercDecode = require('../util/LercDecode.js');
const dom = require('../util/dom');

class LercSource extends Evented {

    constructor(id, options, dispatcher, eventedParent) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;
        this.setEventedParent(eventedParent);

        this.type = 'lerc';
        this.minzoom = 0;
        this.maxzoom = 9;
        this.roundZoom = true;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this._loaded = false;
        this.options = options;
        util.extend(this, util.pick(options, ['url', 'scheme', 'tileSize', 'minzoom', 'maxzoom']));
    }

    load() {
        this.fire('dataloading', { dataType: 'source' });
        // this.loadTile();
        loadTileJSON(this.options, (err, tileJSON) => {
            if (err) {
                return this.fire('error', err);
            }
            util.extend(this, tileJSON);
            this.setBounds(tileJSON.bounds);


            // `content` is included here to prevent a race condition where `Style#_updateSources` is called
            // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
            // ref: https://github.com/mapbox/mapbox-gl-js/pull/4347#discussion_r104418088
            this.fire('data', { dataType: 'source', sourceDataType: 'metadata' });
            this.fire('data', { dataType: 'source', sourceDataType: 'content' });

        });
    }

    onAdd(map) {
        this.load();
        this.map = map;
    }

    setBounds(bounds) {
        this.bounds = bounds;
        if (bounds) {
            this.tileBounds = new TileBounds(bounds, this.minzoom, this.maxzoom);
        }
    }

    serialize() {
        return {
            type: 'lerc',
            url: this.url,
            tileSize: this.tileSize,
            tiles: this.tiles,
            bounds: this.bounds,
        };
    }

    hasTile(coord) {
        return !this.tileBounds || this.tileBounds.contains(coord, this.maxzoom);
    }

    loadTile(tile, callback) {
        const url = normalizeURL(tile.coord.url(this.tiles, null, this.scheme), this.url, this.tileSize);
        const s = url.replace(/\$/g, '');
        tile.request = ajax.getArrayBuffer(s, done.bind(this));

        function done(err, data) {
            delete tile.request;

            if (tile.aborted) {
                this.state = 'unloaded';
                return callback(null);
            }

            if (err) {
                this.state = 'errored';
                return callback(err);
            }

            var img = dom.create('canvas', 'tmp-canvas');
            img.decodedPixels = LercDecode.decode(data.data);
            var width = img.decodedPixels.width;
            img.width = width;
            var height = img.decodedPixels.height;
            img.height = height;
            var min = img.decodedPixels.statistics[0].minValue;
            var max = img.decodedPixels.statistics[0].maxValue;
            var pixels = img.decodedPixels.pixels[0];
            var mask = img.decodedPixels.maskData;

            var ctx = img.getContext('2d');
            var imageData = ctx.createImageData(width, height);
            var data = imageData.data;
            var f = 256 / (max - min);
            var pv = 0;
            for (var i = 0; i < width * height; i++) {
                // Skip the last pixel in each input line
                var j = i + Math.floor(i / width);
                pv = (pixels[j] - min) * f;
                data[i * 4] = pv;
                data[i * 4 + 1] = pv;
                data[i * 4 + 2] = pv;
                // Mask only gets returned when missing data exists
                data[i * 4 + 3] = (mask && !mask[j]) ? 0 : 255;
            }
            ctx.putImageData(imageData, 0, 0);

            console.log(img)

            if (this.map._refreshExpiredTiles) tile.setExpiryData(img);
            delete img.cacheControl;
            delete img.expires;

            // tile.state = 'loaded';
            var gl = this.map.painter.gl;
            var image = img;
            var resize = false;

            if (tile.state !== 'loaded') {
                tile.state = 'loaded';
                tile.texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tile.texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            } else if (resize) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            } else if (image instanceof window.HTMLVideoElement || image instanceof window.ImageData || image instanceof window.HTMLCanvasElement) {
                gl.bindTexture(gl.TEXTURE_2D, tile.texture);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
            }

            callback(null);
        }
    }

    abortTile(tile) {
        if (tile.request) {
            tile.request.abort();
            delete tile.request;
        }
    }

    unloadTile(tile) {
        if (tile.texture) this.map.painter.saveTileTexture(tile.texture);
    }
}

module.exports = LercSource;
