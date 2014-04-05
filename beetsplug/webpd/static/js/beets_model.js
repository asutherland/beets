'use strict';


var Item = Backbone.Model.extend({
  urlRoot: '/item'
});
var Items = Backbone.Collection.extend({
  model: Item,
  comparator: 'track',
});

/**
 * Normalize things into a world-view where there are only albums, singles, and
 * compilations.
 */
function normalizeAlbumType(type) {
  switch (type) {
    case 'single':
    case 'remix':
    case 'dj-mix':
      return 'single';

    case 'compilation':
      return 'compilation';

    case 'album':
    case 'ep':
    // If we don't know then assume it's an album
    default:
      return 'album';
  }
}

var Album = Backbone.Model.extend({
  urlRoot: '/album',
  initialize: function() {
    this.set('normalbumtype', normalizeAlbumType(this.get('albumtype')));
  }
});
var Albums = Backbone.Collection.extend({
  model: Album,
  comparator: 'album',
});
var AlbumsWithComputedArtists = Backbone.Collection.extend({
  model: Album,
  comparator: 'album',
  initialize: function() {
    this.artists = new Artists();
    this.artistByName = Object.create(null);
    this.on('add', function(album) {
      var artistName = album.get('albumartist');
      var artist;
      if (artistName in this.artistByName) {
        // console.log('reusing artist', artistName);
        artist = this.artistByName[artistName];
      }
      else {
        // console.log('creating artist', artistName);
        artist = new Artist({ name: artistName });
        this.artists.add(artist);
        this.artistByName[artistName] = artist;
      }
      artist.albums.add(album);
    }.bind(this));
    this.on('remove', function(album) {
      var artistName = album.get('albumartist');
      var artist = this.artistByName[artistName];
      artist.albums.remove(album);
      if (artist.albums.length === 0) {
        this.artists.remove(artist);
        delete this.artistByname[artistName];
      }
    }.bind(this));
  }
});


var Artist = Backbone.Model.extend({
  initialize: function() {
    this.albums = new Albums();
  },
});
var Artists = Backbone.Collection.extend({
  model: Artist,
  comparator: 'name',
});

var allAlbums = new AlbumsWithComputedArtists();
var allArtists = allAlbums.artists;


////////////////////////////////////////////////////////////////////////////////
// Artists: A derived collection based on allAlbums.


var ALBUM_FETCH_CHUNK_SIZE = 100;
function populateAlbums(highAlbumId) {
  var nextId = 0;

  function getMore() {
    if (nextId >= highAlbumId) {
      done();
      return;
    }

    var lowId = nextId;
    var highId = Math.min(lowId + ALBUM_FETCH_CHUNK_SIZE - 1, highAlbumId);
    nextId = highId + 1;
    var ids = [];
    for (var id = lowId; id <= highId; id++) {
      ids.push(id);
    }
    var url = '/album/' + ids.join(',');
    $.ajax({
      dataType: 'json',
      url: url,
      success: function(data) {
        // if there was only one album in the range, we need to normalize
        if (!data.albums) {
          data = { albums: [data] };
        }
        //console.log('fetched albums:', lowId, '-', highId, 'got',
        //            data.albums.length);
        allAlbums.add(data.albums);
        getMore();
      },
      error: function() {
        //console.log('range was missing albums:', lowId, '-', highId);
        getMore();
      },
    });
  }

  function done() {
    console.log('got all albums through id', highAlbumId);
    if (window.polymerArtistList) {
      window.polymerArtistList.refresh();
    }
  }
  getMore();
}
$.getJSON('/stats', function(stats) {
  populateAlbums(stats.highAlbum);
});
