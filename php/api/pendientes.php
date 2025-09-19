<?php
// Indicamos que la respuesta será en JSON
header('Content-Type: application/json; charset=utf-8');

// Creamos un array con la estructura deseada
$data = [
    [
        "nombre" => "Juan Pérez",
        "movil"  => "644619636",
        "url"    => "https://ejemplo.com/juan",
        "comercial" => "María Gómez",
        "origen" => "Formularios Web",
    ],
    [
        "nombre" => "María López",
        "movil"  => "34644619636",
        "url"    => "https://ejemplo.com/maria",
        "comercial" => "Juan Pérez",
        "origen" => "Formularios Web",
    ],
    [
        "nombre" => "Carlos Sánchez",
        "movil"  => "+34644619636",
        "url"    => "https://ejemplo.com/carlos",
        "comercial" => "María Gómez",
        "origen" => "Formularios Web",
    ]
];

// Devolvemos el JSON
echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
